import { CursorStats, UsageLimitResponse, ExtendedAxiosError, UsageItem, CursorUsageResponse, CurrentPeriodUsageResponse } from '../interfaces/types';
import { log } from '../utils/logger';
import { withNetworkRetry } from '../utils/networkRetry';
import { checkTeamMembership, getTeamSpend, extractUserSpend } from './team';
import { getExtensionContext } from '../extension';
import { t } from '../utils/i18n';
import * as fs from 'fs';
import { cursorApiClient, getCursorApiRetryOptions } from './cursorHttpClient';

export async function getCurrentUsageLimit(token: string, teamId?: number): Promise<UsageLimitResponse> {
    try {
        const payload = teamId ? { teamId } : {};
        const response = await withNetworkRetry(
            () => cursorApiClient.post('/api/dashboard/get-hard-limit', 
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `WorkosCursorSessionToken=${token}`
                    }
                }
            ),
            getCursorApiRetryOptions('get-hard-limit')
        );
        return response.data;
    } catch (error: any) {
        log('[API] Error fetching usage limit: ' + error.message, true);
        throw error;
    }
}

export async function setUsageLimit(token: string, hardLimit: number, noUsageBasedAllowed: boolean): Promise<void> {
    try {
        await cursorApiClient.post('/api/dashboard/set-hard-limit', 
            {
                hardLimit,
                noUsageBasedAllowed
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: `WorkosCursorSessionToken=${token}`
                }
            }
        );
        log(`[API] Successfully ${noUsageBasedAllowed ? 'disabled' : 'enabled'} usage-based pricing with limit: $${hardLimit}`);
    } catch (error: any) {
        log('[API] Error setting usage limit: ' + error.message, true);
        throw error;
    }
}

export async function checkUsageBasedStatus(token: string, teamId?: number): Promise<{isEnabled: boolean, isKnown: boolean, limit?: number}> {
    const payload = teamId ? { teamId } : {};
    let isEnabled: boolean;

    try {
        // Use the same endpoint that the web dashboard uses
        log(`[API] Checking usage-based status with payload: ${JSON.stringify(payload)}`);
        
        const response = await withNetworkRetry(
            () => cursorApiClient.post('/api/dashboard/get-usage-based-premium-requests', 
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `WorkosCursorSessionToken=${token}`
                    }
                }
            ),
            getCursorApiRetryOptions('get-usage-based-premium-requests')
        );
        
        log(`[API] Usage-based status response: ${JSON.stringify(response.data)}`);
        isEnabled = response.data.usageBasedPremiumRequests === true;
        log(`[API] Usage-based pricing is ${isEnabled ? 'enabled' : 'disabled'}`);
    } catch (error: any) {
        log(`[API] Error checking usage-based status: ${error.message}`, true);
        log(`[API] Error details: ${JSON.stringify({
            status: error.response?.status,
            data: error.response?.data,
            teamId: teamId
        })}`, true);
        return {
            isEnabled: false,
            isKnown: false
        };
    }

    try {
        const limitResponse = await getCurrentUsageLimit(token, teamId);
        log(`[API] Hard limit response: ${JSON.stringify(limitResponse)}`);
        return {
            isEnabled,
            isKnown: true,
            limit: limitResponse.hardLimit
        };
    } catch (error: any) {
        log(`[API] Usage-based status is known, but the hard limit could not be fetched: ${error.message}`, true);
        return {
            isEnabled,
            isKnown: true
        };
    }
}

async function fetchMonthData(token: string, month: number, year: number): Promise<{ items: UsageItem[], hasUnpaidMidMonthInvoice: boolean, midMonthPayment: number }> {
    log(`[API] Fetching data for ${month}/${year}`);
    try {
        // Path to local dev data file, leave empty for production
        const devDataPath: string = "";

        let response;
        if (devDataPath) {
            try {
                log(`[API] Dev mode enabled, reading from: ${devDataPath}`);
                const rawData = fs.readFileSync(devDataPath, 'utf8');
                response = { data: JSON.parse(rawData) };
                log('[API] Successfully loaded dev data');
            } catch (devError: any) {
                log('[API] Error reading dev data: ' + devError.message, true);
                throw devError;
            }
        } else {
            response = await withNetworkRetry(
                () => cursorApiClient.post('/api/dashboard/get-monthly-invoice', {
                    month,
                    year,
                    includeUsageEvents: false
                }, {
                    headers: {
                        'Content-Type': 'application/json',
                        Cookie: `WorkosCursorSessionToken=${token}`
                    }
                }),
                getCursorApiRetryOptions(`get-monthly-invoice ${month}/${year}`, 700)
            );
        }
        
        const usageItems: UsageItem[] = [];
        let midMonthPayment = 0;
        if (response.data.items) {
            // First pass: find the maximum request count and cost per request among valid items
            let maxRequestCount = 0;
            let maxCostPerRequest = 0;
            for (const item of response.data.items) {
                // Skip items without cents value or mid-month payments
                if (!item.hasOwnProperty('cents') || typeof item.cents === 'undefined' || item.description.includes('Mid-month usage paid')) {
                    continue;
                }
                
                let currentItemRequestCount = 0;
                const tokenBasedMatch = item.description.match(/^(\d+) token-based usage calls to/);
                if (tokenBasedMatch && tokenBasedMatch[1]) {
                    currentItemRequestCount = parseInt(tokenBasedMatch[1]);
                } else {
                    const originalMatch = item.description.match(/^(\d+)/); // Match digits at the beginning
                    if (originalMatch && originalMatch[1]) {
                        currentItemRequestCount = parseInt(originalMatch[1]);
                    }
                }

                if (currentItemRequestCount > 0) {
                    maxRequestCount = Math.max(maxRequestCount, currentItemRequestCount);
                    
                    // Calculate cost per request for this item to find maximum
                    const costPerRequestCents = item.cents / currentItemRequestCount;
                    const costPerRequestDollars = costPerRequestCents / 100;
                    maxCostPerRequest = Math.max(maxCostPerRequest, costPerRequestDollars);
                }
            }
            
            // Calculate the padding width based on the maximum request count
            const paddingWidth = maxRequestCount > 0 ? maxRequestCount.toString().length : 1; // Ensure paddingWidth is at least 1
            
            // Calculate the padding width for cost per request (format to 3 decimal places and find max width)
            // Max cost will be something like "XX.XXX" or "X.XXX", so we need to find the max length of that string.
            // Let's find the maximum cost in cents first to determine the number of integer digits.
            let maxCostCentsForPadding = 0;
            for (const item of response.data.items) {
                if (!item.hasOwnProperty('cents') || typeof item.cents === 'undefined' || item.description.includes('Mid-month usage paid')) {
                    continue;
                }
                let currentItemRequestCount = 0;
                const tokenBasedMatch = item.description.match(/^(\d+) token-based usage calls to/);
                if (tokenBasedMatch && tokenBasedMatch[1]) {
                    currentItemRequestCount = parseInt(tokenBasedMatch[1]);
                } else {
                    const originalMatch = item.description.match(/^(\d+)/);
                    if (originalMatch && originalMatch[1]) {
                        currentItemRequestCount = parseInt(originalMatch[1]);
                    }
                }
                if (currentItemRequestCount > 0) {
                    const costPerRequestCents = item.cents / currentItemRequestCount;
                    maxCostCentsForPadding = Math.max(maxCostCentsForPadding, costPerRequestCents);
                }
            }
            // Now format this max cost per request to get its string length
            const maxCostPerRequestForPaddingFormatted = (maxCostCentsForPadding / 100).toFixed(3);
            const costPaddingWidth = maxCostPerRequestForPaddingFormatted.length;

            for (const item of response.data.items) {
                
                // Skip items without cents value
                if (!item.hasOwnProperty('cents')) {
                    log('[API] Skipping item without cents value: ' + item.description);
                    continue;
                }
                
                // Check if this is a mid-month payment
                if (item.description.includes('Mid-month usage paid')) {
                    // Skip if cents is undefined
                    if (typeof item.cents === 'undefined') {
                        continue;
                    }
                    // Add to the total mid-month payment amount (convert from cents to dollars)
                    midMonthPayment += Math.abs(item.cents) / 100;
                    log(`[API] Added mid-month payment of $${(Math.abs(item.cents) / 100).toFixed(2)}, total now: $${midMonthPayment.toFixed(2)}`);
                    // Add a special line for mid-month payment that statusBar.ts can parse
                    usageItems.push({
                        calculation: `${t('api.midMonthPayment')}: $${midMonthPayment.toFixed(2)}`,
                        totalDollars: `-$${midMonthPayment.toFixed(2)}`,
                        description: item.description
                    });
                    continue; // Skip adding this to regular usage items
                }

                // Logic to parse different item description formats
                const cents = item.cents;

                if (typeof cents === 'undefined') {
                    log('[API] Skipping item with undefined cents value: ' + item.description);
                    continue;
                }

                let requestCount: number;
                let parsedModelName: string; // Renamed from modelInfo for clarity
                let isToolCall = false;

                const tokenBasedMatch = item.description.match(/^(\d+) token-based usage calls to ([\w.-]+), totalling: \$(?:[\d.]+)/);
                if (tokenBasedMatch) {
                    requestCount = parseInt(tokenBasedMatch[1]);
                    parsedModelName = tokenBasedMatch[2];
                } else {
                    const originalMatch = item.description.match(/^(\d+)\s+(.+?)(?: request| calls)?(?: beyond|\*| per|$)/i);
                    if (originalMatch) {
                        requestCount = parseInt(originalMatch[1]);
                        const extractedDescription = originalMatch[2].trim();

                        // Updated pattern to handle "discounted" prefix and include claude-4-sonnet
                        const genericModelPattern = /\b(?:discounted\s+)?(claude-(?:3-(?:opus|sonnet|haiku)|3\.[57]-sonnet(?:-[\w-]+)?(?:-max)?|4-sonnet(?:-thinking)?)|gpt-(?:4(?:\.\d+|o-128k|-preview)?|3\.5-turbo)|gemini-(?:1\.5-flash-500k|2[\.-]5-pro-(?:exp-\d{2}-\d{2}|preview-\d{2}-\d{2}|exp-max))|o[134](?:-mini)?)\b/i;
                        const specificModelMatch = item.description.match(genericModelPattern);

                        if (item.description.includes("tool calls")) {
                            parsedModelName = t('api.toolCalls');
                            isToolCall = true;
                        } else if (specificModelMatch) {
                            // Extract the model name (group 1), which excludes the "discounted" prefix
                            parsedModelName = specificModelMatch[1];
                        } else if (item.description.includes("extra fast premium request")) {
                            const extraFastModelMatch = item.description.match(/extra fast premium requests? \(([^)]+)\)/i);
                            if (extraFastModelMatch && extraFastModelMatch[1]) {
                                parsedModelName = extraFastModelMatch[1]; // e.g., Haiku
                            } else {
                                parsedModelName = t('api.fastPremium');
                            }
                        } else {
                            // Fallback for unknown model structure
                            parsedModelName = t('statusBar.unknownModel'); // Default to unknown-model
                            log(`[API] Could not determine specific model for (original format): "${item.description}". Using "${parsedModelName}".`);
                        }
                    } else {
                        log('[API] Could not extract request count or model info from: ' + item.description);
                        parsedModelName = t('statusBar.unknownModel'); // Ensure it's set for items we can't parse fully
                        // Try to get at least a request count if possible, even if model is unknown
                        const fallbackCountMatch = item.description.match(/^(\d+)/);
                        if (fallbackCountMatch) {
                            requestCount = parseInt(fallbackCountMatch[1]);
                        } else {
                            continue; // Truly unparsable
                        }
                    }
                }
                
                // Skip items with 0 requests to avoid division by zero
                if (requestCount === 0) {
                    log('[API] Skipping item with 0 requests: ' + item.description);
                    continue;
                }
                
                const costPerRequestCents = cents / requestCount;
                const totalDollars = cents / 100;

                const paddedRequestCount = requestCount.toString().padStart(paddingWidth, '0');
                const costPerRequestDollarsFormatted = (costPerRequestCents / 100).toFixed(3).padStart(costPaddingWidth, '0');
                
                const isTotallingItem = !!tokenBasedMatch; 
                const tilde = isTotallingItem ? "~" : "&nbsp;&nbsp;";
                const itemUnit = t('api.requestUnit'); // Always use "req" as the unit
                
                // Simplified calculation string, model name is now separate
                const calculationString = `**${paddedRequestCount}** ${itemUnit} @ **$${costPerRequestDollarsFormatted}${tilde}**`;

                usageItems.push({
                    calculation: calculationString,
                    totalDollars: `$${totalDollars.toFixed(2)}`,
                    description: item.description,
                    modelNameForTooltip: parsedModelName, // Store the determined model name here
                    isDiscounted: item.description.toLowerCase().includes("discounted") // Add a flag for discounted items
                });
            }
        }
        
        return {
            items: usageItems,
            hasUnpaidMidMonthInvoice: response.data.hasUnpaidMidMonthInvoice,
            midMonthPayment
        };
    } catch (error: any) {
        const axiosError = error as ExtendedAxiosError;
        log(`[API] Error fetching monthly data for ${month}/${year}: ${axiosError.message}`, true);
        log('[API] API error details: ' + JSON.stringify({
            status: axiosError.response?.status,
            data: axiosError.response?.data,
            message: axiosError.message
        }), true);
        throw error;
    }
}

export async function fetchCursorStats(token: string): Promise<CursorStats> {
    return fetchCursorStatsOnce(token);
}

export async function fetchCursorUsage(token: string): Promise<CursorUsageResponse> {
    const userId = token.split('%3A%3A')[0];
    const response = await withNetworkRetry(
        () => cursorApiClient.get<CursorUsageResponse>('/api/usage', {
            params: { user: userId },
            headers: { Cookie: `WorkosCursorSessionToken=${token}` }
        }),
        getCursorApiRetryOptions('get-usage')
    );
    return response.data;
}

async function fetchCursorStatsOnce(token: string): Promise<CursorStats> {
    try {
        // Check if user is a team member
        const context = getExtensionContext();
        const teamInfo = await checkTeamMembership(token, context);

        let premiumRequests;
        let isUsingTeamSpend = false;
        
        if (teamInfo.isTeamMember && teamInfo.teamId && teamInfo.userId) {
            // Use team spend data for team members to get team-specific usage
            log('[API] User is team member, fetching team spend data...');
            try {
                const teamSpend = await getTeamSpend(token, teamInfo.teamId);
                const userSpend = extractUserSpend(teamSpend, teamInfo.userId);

                
                // Get individual usage to get the premium request limit (GPT-4)
                const individualUsage = await fetchCursorUsage(token);
                
                // Use GPT-4 data for both current usage and limit since it updates faster
                const premiumRequestLimit = individualUsage['gpt-4'].maxRequestUsage || 500;
                
                premiumRequests = {
                    current: individualUsage['gpt-4'].numRequests, // Use GPT-4 number instead of team spend
                    limit: premiumRequestLimit, // Use the premium request limit (500)
                    startOfMonth: teamInfo.startOfMonth
                };
                
                log('[API] Successfully extracted team member data with premium request limit', {
                    teamPremiumRequests: userSpend.fastPremiumRequests || 0,
                    individualPremiumRequests: individualUsage['gpt-4'].numRequests,
                    premiumRequestLimit: premiumRequestLimit,
                    usageBasedLimit: individualUsage['gpt-4-32k'].maxRequestUsage,
                    usageBasedCurrent: individualUsage['gpt-4-32k'].numRequests,
                    hardLimitOverrideDollars: userSpend.hardLimitOverrideDollars,
                    userName: userSpend.name,
                    usingGPT4Number: true // Log that we're using GPT-4 number
                });
                
                isUsingTeamSpend = true;
            } catch (spendError: any) {
                log('[API] Team spend failed, falling back to individual usage API: ' + spendError.message, true);
                // Fall through to individual API
            }
        }
        
        // Fallback to individual usage API if team methods failed or user is not a team member
        if (!premiumRequests) {
            log('[API] Using individual usage API...');
            const usageData = await fetchCursorUsage(token);
            log('[API] Successfully fetched individual usage data', {
                gpt4Requests: usageData['gpt-4'].numRequests,
                gpt4Limit: usageData['gpt-4'].maxRequestUsage,
                gpt4Tokens: usageData['gpt-4'].numTokens,
                startOfMonth: usageData.startOfMonth
            });

            premiumRequests = {
                current: usageData['gpt-4'].numRequests,
                limit: usageData['gpt-4'].maxRequestUsage,
                startOfMonth: usageData.startOfMonth
            };
        }

        // Get current date for usage-based pricing (which renews on 2nd/3rd of each month)
        const currentDate = new Date();
        const usageBasedBillingDay = 3; // Assuming it's the 3rd day of the month
        let usageBasedCurrentMonth = currentDate.getMonth() + 1;
        let usageBasedCurrentYear = currentDate.getFullYear();
        
        // If we're in the first few days of the month (before billing date),
        // consider the previous month as the current billing period
        if (currentDate.getDate() < usageBasedBillingDay) {
            usageBasedCurrentMonth = usageBasedCurrentMonth === 1 ? 12 : usageBasedCurrentMonth - 1;
            if (usageBasedCurrentMonth === 12) {
                usageBasedCurrentYear--;
            }
        }

        // Calculate previous month for usage-based pricing
        const usageBasedLastMonth = usageBasedCurrentMonth === 1 ? 12 : usageBasedCurrentMonth - 1;
        const usageBasedLastYear = usageBasedCurrentMonth === 1 ? usageBasedCurrentYear - 1 : usageBasedCurrentYear;

        const currentMonthData = await fetchMonthData(token, usageBasedCurrentMonth, usageBasedCurrentYear);
        const lastMonthData = await fetchMonthData(token, usageBasedLastMonth, usageBasedLastYear);

        log(`[API] Returning stats with teamId: ${teamInfo.teamId}, isTeamSpendData: ${isUsingTeamSpend}`);
        
        return {
            currentMonth: {
                month: usageBasedCurrentMonth,
                year: usageBasedCurrentYear,
                usageBasedPricing: currentMonthData
            },
            lastMonth: {
                month: usageBasedLastMonth,
                year: usageBasedLastYear,
                usageBasedPricing: lastMonthData
            },
            premiumRequests,
            isTeamSpendData: isUsingTeamSpend,
            teamId: teamInfo.teamId
        };
    } catch (error: any) {
        log('[API] Error fetching premium requests: ' + error, true);
        log('[API] API error details: ' + JSON.stringify({
            status: error.response?.status,
            data: error.response?.data,
            message: error.message
        }), true);
        throw error;
    }
}

export async function getStripeSessionUrl(token: string): Promise<string> {
    try {
        const response = await withNetworkRetry(
            () => cursorApiClient.get('/api/stripeSession', {
                headers: {
                    Cookie: `WorkosCursorSessionToken=${token}`
                }
            }),
            getCursorApiRetryOptions('get-stripe-session')
        );
        // Remove quotes from the response string
        return response.data.replace(/"/g, '');
    } catch (error: any) {
        log('[API] Error getting Stripe session URL: ' + error.message, true);
        throw error;
    }
}

// 新增：获取用户使用事件数量
export async function getUsageEventCount(token: string): Promise<number> {
    try {
        const now = Date.now();
        const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
        const endDate = now;
        const startDate = now - THIRTY_DAYS;
        const payload = {
            teamId: 0,
            startDate: startDate.toString(),
            endDate: endDate.toString(),
            page: 1,
            pageSize: 10
        };
        const response = await withNetworkRetry(
            () =>
                cursorApiClient.post('/api/dashboard/get-filtered-usage-events', payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Referer': 'https://cursor.com/cn/dashboard',
                        Cookie: `NEXT_LOCALE=cn;WorkosCursorSessionToken=${token}`,
                    },
                }),
            getCursorApiRetryOptions('get-filtered-usage-events', 500),
        );
        // 返回 totalUsageEventsCount 字段
        if (response.data && typeof response.data.totalUsageEventsCount === 'number') {
            return response.data.totalUsageEventsCount;
        }
        throw new Error('Usage event count response did not contain a numeric total');
    } catch (error: any) {
        log('[API] Error getting usage event count: ' + error.message, true);
        throw error;
    }
}

/** 获取当前计费周期使用量（含使用量百分比） */
export async function getCurrentPeriodUsage(token: string): Promise<CurrentPeriodUsageResponse | null> {
    try {
        const response = await withNetworkRetry(
            () =>
                cursorApiClient.post<CurrentPeriodUsageResponse>(
                    '/api/dashboard/get-current-period-usage',
                    {},
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            Accept: '*/*',
                            Referer: 'https://cursor.com/cn/dashboard?tab=spending',
                            Cookie: `WorkosCursorSessionToken=${token}`,
                        },
                    },
                ),
            getCursorApiRetryOptions('get-current-period-usage', 500),
        );
        return response.data;
    } catch (error: any) {
        log('[API] Error getting current period usage: ' + error.message, true);
        return null;
    }
} 
