import { log } from './logger';
import { getCursorTokenFromDB } from '../services/database';
import { checkUsageBasedStatus, fetchCursorStats, fetchCursorUsage, getCurrentPeriodUsage, getUsageEventCount } from '../services/api';
import { checkAndNotifyUsage, checkAndNotifySpending, checkAndNotifyUnpaidInvoice } from '../handlers/notifications';
import { 
    startRefreshInterval,
    getCooldownStartTime,
    getConsecutiveErrorCount,
    incrementConsecutiveErrorCount,
    setCooldownStartTime,
    resetConsecutiveErrorCount
} from './cooldown';
import { createMarkdownTooltip, formatTooltipLine, getMaxLineWidth, getStatusBarColor, createSeparator } from '../handlers/statusBar';
import * as vscode from 'vscode';
import { convertAndFormatCurrency, getCurrentCurrency } from './currency';
import { t } from './i18n';

// Track unknown models to avoid repeated notifications
let unknownModelNotificationShown = false;
let detectedUnknownModels: Set<string> = new Set();
let activeStatsUpdate: Promise<void> | null = null;

export async function updateStats(statusBarItem: vscode.StatusBarItem): Promise<void> {
    if (activeStatsUpdate) {
        log('[Stats] Reusing the active stats update');
        return activeStatsUpdate;
    }

    activeStatsUpdate = performStatsUpdate(statusBarItem);
    try {
        await activeStatsUpdate;
    } finally {
        activeStatsUpdate = null;
    }
}

async function performStatsUpdate(statusBarItem: vscode.StatusBarItem): Promise<void> {
    try {
        log('[Stats] ' +"=".repeat(100));
        log('[Stats] Starting stats update...');
        const token = await getCursorTokenFromDB();
       
        if (!token) {
            log('[Critical] No valid token found', true);
            statusBarItem.text = `$(alert) ${t('statusBar.noTokenFound')}`;
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorBackground');
            const tooltipLines = [
                t('statusBar.couldNotRetrieveToken')
            ];
            statusBarItem.tooltip = await createMarkdownTooltip(tooltipLines, true);
            log('[Status Bar] Updated status bar with no token message');
            statusBarItem.show();
            log('[Status Bar] Status bar visibility updated after no token');
            return;
        }

        // Show status bar early to ensure visibility
        statusBarItem.show();

        const stats = await fetchCursorStats(token).catch(async (error: any) => {
            if (error.response?.status === 401 || error.response?.status === 403) {
                log('[Auth] Token expired or invalid, attempting to refresh...', true);
                const newToken = await getCursorTokenFromDB();
                if (newToken) {
                    log('[Auth] Successfully retrieved new token, retrying stats fetch...');
                    return await fetchCursorStats(newToken);
                }
            }
            log(`[Critical] API error: ${error.message}`, true);
            throw error; // Re-throw to be caught by outer catch
        });

        // Reset error count on successful fetch
        if (getConsecutiveErrorCount() > 0 || getCooldownStartTime()) {
            log('[Stats] API connection restored, resetting error state');
            resetConsecutiveErrorCount();
            if (getCooldownStartTime()) {
                setCooldownStartTime(null);
                startRefreshInterval();
            }
        }

        // Check usage-based status with team information if available
        const usageStatus = await checkUsageBasedStatus(token, stats.teamId);
        log(`[Stats] Usage-based pricing status: ${JSON.stringify(usageStatus)}`);
        
        let costText = '';
        
        let usageBasedPercent = 0;

        // 使用 get-current-period-usage 接口获取当前周期使用量百分比（状态栏 / tooltip / 通知统一使用）
        let periodTotalPercent: number | null = null;
        let periodAutoPercent: number | null = null;
        let periodApiPercent: number | null = null;
        let periodUsage: Awaited<ReturnType<typeof getCurrentPeriodUsage>> = null;
        let usageEventCount: number | null = null;
        try {
            const [periodResult, eventCount] = await Promise.all([
                getCurrentPeriodUsage(token),
                getUsageEventCount(token).catch(() => null)
            ]);
            periodUsage = periodResult;
            if (periodUsage?.planUsage) {
                const { totalPercentUsed, autoPercentUsed, apiPercentUsed } = periodUsage.planUsage;
                if (typeof totalPercentUsed === 'number') {
                    periodTotalPercent = Math.round(totalPercentUsed);
                }
                if (typeof autoPercentUsed === 'number') {
                    periodAutoPercent = Math.round(autoPercentUsed);
                }
                if (typeof apiPercentUsed === 'number') {
                    periodApiPercent = Math.round(apiPercentUsed);
                }
                log(`[Stats] 当前周期使用量: auto=${periodAutoPercent ?? '—'}%, api=${periodApiPercent ?? '—'}%, total=${periodTotalPercent ?? '—'}%`);
            }
            if (typeof eventCount === 'number') {
                usageEventCount = eventCount;
            }
        } catch (e) {
            log('[Stats] 获取周期使用量失败: ' + (e instanceof Error ? e.message : String(e)), true);
        }

        // Use current month if it has data, otherwise fall back to last month
        const activeMonthData = stats.currentMonth.usageBasedPricing.items.length > 0 
            ? stats.currentMonth 
            : stats.lastMonth;
        
        log(`[Stats] Using ${activeMonthData === stats.currentMonth ? 'current' : 'last'} month data (${activeMonthData.month}/${activeMonthData.year})`);
        
        if (activeMonthData.usageBasedPricing.items.length > 0) {
            const items = activeMonthData.usageBasedPricing.items;
            
            // Calculate actual total cost (sum of positive items only)
            const actualTotalCost = items.reduce((sum, item) => {
                const cost = parseFloat(item.totalDollars.replace('$', ''));
                // Only add positive costs (ignore mid-month payment credits)
                return cost > 0 ? sum + cost : sum;
            }, 0);

            // Usage-based requests are tracked separately and not added to the premium count
            
            // Calculate usage percentage based on actual total cost (always in USD)
            if (usageStatus.isEnabled && usageStatus.limit) {
                usageBasedPercent = (actualTotalCost / usageStatus.limit) * 100;
            }
            
            // Convert actual cost currency for status bar display
            const formattedActualCost = await convertAndFormatCurrency(actualTotalCost);
            costText = ` $(credit-card) ${formattedActualCost}`;
        }

        // 状态栏：auto/api 使用量百分比 + 费用 + 使用事件数（仅展示）
        const displayAutoPercent = periodAutoPercent !== null ? periodAutoPercent : '—';
        const displayApiPercent = periodApiPercent !== null ? periodApiPercent : '—';
        const eventCountText = usageEventCount !== null ? ` | ${usageEventCount}` : '';
        const totalUsageText = ` ${displayAutoPercent}%/${displayApiPercent}%${costText}${eventCountText}`;

        // 状态栏颜色：使用当前周期 total 使用量百分比
        const usagePercent = periodTotalPercent !== null ? periodTotalPercent : 0;
        // 高级模型（API 池）通知：使用 periodApiPercent
        const advancedModelsPercent = periodApiPercent !== null ? periodApiPercent : 0;
        
        log(`[Stats] Color calculation details:`, {
            periodAutoPercent,
            periodApiPercent,
            periodTotalPercent,
            usageBasedPercent: usageBasedPercent,
            usageBasedEnabled: usageStatus.isEnabled,
            finalUsagePercent: usagePercent,
            advancedModelsPercent
        });
        
        statusBarItem.color = getStatusBarColor(usagePercent);

        // Build content first to determine width
        const title = t('statusBar.cursorUsageStats');
        const contentLines = [
            title,
            ''
        ];
        
        // Add Team Spend section if using team spend data
        if (stats.isTeamSpendData) {
            contentLines.push(t('statusBar.teamSpend'));
        }
        
        // Tooltip：当前计费周期使用量百分比（与状态栏一致）
        contentLines.push(t('statusBar.currentPeriodUsage'));
        const formatDateWithMonthName = (date: Date) => {
            const day = date.getDate();
            const monthNames = [
                t('statusBar.months.january'),
                t('statusBar.months.february'),
                t('statusBar.months.march'),
                t('statusBar.months.april'),
                t('statusBar.months.may'),
                t('statusBar.months.june'),
                t('statusBar.months.july'),
                t('statusBar.months.august'),
                t('statusBar.months.september'),
                t('statusBar.months.october'),
                t('statusBar.months.november'),
                t('statusBar.months.december')
            ];
            const monthName = monthNames[date.getMonth()];
            return `${day} ${monthName}`;
        };
        const autoPercentFormatted = periodAutoPercent !== null ? `${periodAutoPercent}%` : '—';
        const apiPercentFormatted = periodApiPercent !== null ? `${periodApiPercent}%` : '—';
        const totalPercentFormatted = periodTotalPercent !== null ? `${periodTotalPercent}%` : '—';
        let periodLabel = '';
        if (periodUsage?.billingCycleStart && periodUsage?.billingCycleEnd) {
            const start = new Date(parseInt(periodUsage.billingCycleStart, 10));
            const end = new Date(parseInt(periodUsage.billingCycleEnd, 10));
            periodLabel = `${formatDateWithMonthName(start)} - ${formatDateWithMonthName(end)}`;
        } else {
            const startDate = new Date(stats.premiumRequests.startOfMonth);
            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + 1);
            periodLabel = `${formatDateWithMonthName(startDate)} - ${formatDateWithMonthName(endDate)}`;
        }
        contentLines.push(
            formatTooltipLine(`   🤖 ${t('statusBar.autoUsage')}: ${autoPercentFormatted}`),
            formatTooltipLine(`   ⚡ ${t('statusBar.advancedModelsUsage')}: ${apiPercentFormatted}`),
            formatTooltipLine(`   📊 ${t('statusBar.totalUsage')}: ${totalPercentFormatted} ${t('statusBar.utilized')}`),
            formatTooltipLine(`   ${t('statusBar.fastRequestsPeriod')}: ${periodLabel}`),
            ''
        );

        // Add detailed model usage breakdown if available
        try {
            const usageData = await fetchCursorUsage(token);
            
            // Show team vs individual comparison if using team spend data
            if (stats.isTeamSpendData) {
                // Get team spend data for comparison
                let teamSpendRequests = 'N/A';
                try {
                    const { checkTeamMembership, getTeamSpend, extractUserSpend } = await import('../services/team');
                    const context = await import('../extension').then(m => m.getExtensionContext());
                    const teamInfo = await checkTeamMembership(token, context);
                    
                    if (teamInfo.isTeamMember && teamInfo.teamId && teamInfo.userId) {
                        const teamSpend = await getTeamSpend(token, teamInfo.teamId);
                        const userSpend = extractUserSpend(teamSpend, teamInfo.userId);
                        teamSpendRequests = (userSpend.fastPremiumRequests || 0).toString();
                    }
                } catch (error) {
                    log('[Stats] Error fetching team spend for comparison: ' + error, true);
                }
                
                contentLines.push(
                    '🔍 **Data Source Information**',
                    formatTooltipLine(`   • **Current Display**: Using GPT-4 individual data (${usageData['gpt-4'].numRequests} requests)`),
                    formatTooltipLine(`   • **Team Spend Data**: ${teamSpendRequests} requests (may update slower)`),
                    ''
                );
            }
            
            contentLines.push(
                '📊 **Detailed Usage Breakdown**',
                ''
            );
            
            // Show data for each model with better labeling
            Object.entries(usageData).forEach(([modelName, data]) => {
                if (typeof data === 'object' && data !== null && 'numRequests' in data) {
                    const modelData = data as any;
                    const hasLimit = modelData.maxRequestUsage !== null;
                    const hasTokens = modelData.numTokens > 0;
                    
                    let displayName = modelName;
                    let description = '';
                    
                    // Better labeling based on your clarification
                    if (modelName === 'gpt-4') {
                        displayName = 'GPT-4 (Premium/Fast)';
                        description = 'Fast premium requests';
                    } else if (modelName === 'gpt-4-32k') {
                        displayName = 'GPT-4-32k (Usage-Based)';
                        description = 'Usage-based spending limit';
                    } else if (modelName === 'gpt-3.5-turbo') {
                        displayName = 'GPT-3.5-turbo';
                        description = 'Legacy model';
                    }
                    
                    let modelLine = `   • **${displayName}**: ${modelData.numRequests} requests`;
                    if (hasLimit) {
                        modelLine += ` / ${modelData.maxRequestUsage} limit`;
                    }
                    if (hasTokens) {
                        modelLine += ` (${modelData.numTokens} tokens)`;
                    }
                    
                    contentLines.push(formatTooltipLine(modelLine));
                    
                    // Add description for clarity
                    if (description) {
                        contentLines.push(formatTooltipLine(`     ${description}`));
                    }
                }
            });
            
            contentLines.push(
                '',
                t('statusBar.usageBasedPricing')
            );
        } catch (error) {
            // If we can't get detailed usage data, just continue with the regular flow
            contentLines.push(t('statusBar.usageBasedPricing'));
        }
        
        if (activeMonthData.usageBasedPricing.items.length > 0) {
            const items = activeMonthData.usageBasedPricing.items;

            // Calculate actual total cost (sum of positive items only)
            const actualTotalCost = items.reduce((sum, item) => {
                const cost = parseFloat(item.totalDollars.replace('$', ''));
                return cost > 0 ? sum + cost : sum;
            }, 0);
            
            // Calculate usage-based pricing period for the active month
            const billingDay = 3;
            let periodStart = new Date(activeMonthData.year, activeMonthData.month - 1, billingDay);
            let periodEnd = new Date(activeMonthData.year, activeMonthData.month, billingDay - 1);
            
            // Adjust year if period spans across year boundary
            if (periodEnd < periodStart) {
                periodEnd.setFullYear(periodEnd.getFullYear() + 1);
            }
            
            contentLines.push(
                formatTooltipLine(`   ${t('statusBar.usageBasedPeriod')}: ${formatDateWithMonthName(periodStart)} - ${formatDateWithMonthName(periodEnd)}`),
            );
            
            // Calculate unpaid amount correctly
            const unpaidAmount = Math.max(0, actualTotalCost - activeMonthData.usageBasedPricing.midMonthPayment);
            
            // Calculate usage percentage based on actual total cost (always in USD)
            const usagePercentage = usageStatus.limit ? ((actualTotalCost / usageStatus.limit) * 100).toFixed(1) : '0.0';
            
            // Convert currency for tooltip
            const currencyCode = getCurrentCurrency();
            const formattedActualTotalCost = await convertAndFormatCurrency(actualTotalCost);
            const formattedUnpaidAmount = await convertAndFormatCurrency(unpaidAmount);
            const formattedLimit = await convertAndFormatCurrency(usageStatus.limit || 0);
            
            // Store original values for statusBar.ts to use, using actual total cost
            const originalUsageData = {
                usdTotalCost: actualTotalCost, // Use actual cost here
                usdLimit: usageStatus.limit || 0,
                percentage: usagePercentage
            };
            
            if (activeMonthData.usageBasedPricing.midMonthPayment > 0) {
                contentLines.push(
                    formatTooltipLine(`   ${t('statusBar.currentUsage')} (${t('statusBar.total')}: ${formattedActualTotalCost} - ${t('statusBar.unpaid')}: ${formattedUnpaidAmount})`),
                    formatTooltipLine(`   __USD_USAGE_DATA__:${JSON.stringify(originalUsageData)}`), // Hidden metadata line
                    ''
                );
            } else {
                contentLines.push(
                    formatTooltipLine(`   ${t('statusBar.currentUsage')} (${t('statusBar.total')}: ${formattedActualTotalCost})`),
                    formatTooltipLine(`   __USD_USAGE_DATA__:${JSON.stringify(originalUsageData)}`), // Hidden metadata line 
                    ''
                );
            }
            
            // Determine the maximum length for formatted item costs for padding
            let maxFormattedItemCostLength = 0;
            for (const item of items) {
                if (item.description?.includes('Mid-month usage paid')) {
                    continue;
                }
                const itemCost = parseFloat(item.totalDollars.replace('$', ''));
                // We format with 2 decimal places for display
                const tempFormattedCost = itemCost.toFixed(2); // Format to string with 2 decimals
                if (tempFormattedCost.length > maxFormattedItemCostLength) {
                    maxFormattedItemCostLength = tempFormattedCost.length;
                }
            }

            for (const item of items) {
                // Skip mid-month payment line item from the detailed list
                if (item.description?.includes('Mid-month usage paid')) {
                    continue;
                }

                // If the item has a description, use it to provide better context
                if (item.description) {
                    // Logic for populating detectedUnknownModels for the notification
                    // This now uses modelNameForTooltip as a primary signal from api.ts
                    if (item.modelNameForTooltip === "unknown-model" && item.description) {
                        // api.ts couldn't determine a specific model.
                        // Let's inspect the raw description for a hint for the notification.
                        let extractedTermForNotification = "";

                        // Try to extract model name from specific patterns first
                        const tokenBasedDescMatch = item.description.match(/^(\d+) token-based usage calls to ([\w.-]+),/i);
                        if (tokenBasedDescMatch && tokenBasedDescMatch[2]) {
                            extractedTermForNotification = tokenBasedDescMatch[2].trim();
                        } else {
                            const extraFastMatch = item.description.match(/extra fast premium requests? \(([^)]+)\)/i);
                            if (extraFastMatch && extraFastMatch[1]) {
                                extractedTermForNotification = extraFastMatch[1].trim();
                            } else {
                                // General case: "N ACTUAL_MODEL_NAME_OR_PHRASE requests/calls"
                                const fullDescMatch = item.description.match(/^(\d+)\s+(.+?)(?: request| calls)?(?: beyond|\*| per|$)/i);
                                if (fullDescMatch && fullDescMatch[2]) {
                                    extractedTermForNotification = fullDescMatch[2].trim();
                                    // If it's discounted and starts with "discounted ", remove prefix
                                    if (item.isDiscounted && extractedTermForNotification.toLowerCase().startsWith("discounted ")) {
                                        extractedTermForNotification = extractedTermForNotification.substring(11).trim();
                                    }
                                } else {
                                    // Fallback: first word after number if other patterns fail (less likely to be useful)
                                    const simpleDescMatch = item.description.match(/^(\d+)\s+([\w.-]+)/i); // Changed to [\w.-]+
                                    if (simpleDescMatch && simpleDescMatch[2]) {
                                        extractedTermForNotification = simpleDescMatch[2].trim();
                                    }
                                }
                            }
                        }
                        
                        // General cleanup of suffixes
                        extractedTermForNotification = extractedTermForNotification.replace(/requests?|calls?|beyond|\*|per|,$/gi, '').trim();
                        if (extractedTermForNotification.toLowerCase().endsWith(" usage")) {
                            extractedTermForNotification = extractedTermForNotification.substring(0, extractedTermForNotification.length - 6).trim();
                        }
                        // Ensure it's not an empty string after cleanup
                        if (extractedTermForNotification && 
                            extractedTermForNotification.length > 1 && // Meaningful length
                            extractedTermForNotification.toLowerCase() !== "token-based" &&
                            extractedTermForNotification.toLowerCase() !== "discounted") {

                            const veryGenericKeywords = [
                                'usage', 'calls', 'request', 'requests', 'cents', 'beyond', 'month', 'day',
                                'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
                                'premium', 'extra', 'tool', 'fast', 'thinking'
                                // Model families like 'claude', 'gpt', 'gemini', 'o1' etc. are NOT here, 
                                // as "claude-x" should be flagged if "claude-x" is new.
                            ];
                            
                            const isVeryGeneric = veryGenericKeywords.includes(extractedTermForNotification.toLowerCase());

                            if (!isVeryGeneric) {
                                const alreadyPresent = Array.from(detectedUnknownModels).some(d => d.toLowerCase().includes(extractedTermForNotification.toLowerCase()) || extractedTermForNotification.toLowerCase().includes(d.toLowerCase()));
                                if (!alreadyPresent) {
                                    detectedUnknownModels.add(extractedTermForNotification);
                                    log(`[Stats] Adding to detectedUnknownModels (api.ts flagged as unknown-model, extracted term): '${extractedTermForNotification}' from "${item.description}"`);
                                }
                            }
                        }
                    }
                    
                    // Convert item cost for display
                    const itemCost = parseFloat(item.totalDollars.replace('$', ''));
                    let formattedItemCost = await convertAndFormatCurrency(itemCost);

                    // Pad the numerical part of the formattedItemCost
                    const currencySymbol = formattedItemCost.match(/^[^0-9-.\\,]*/)?.[0] || "";
                    const numericalPart = formattedItemCost.substring(currencySymbol.length);
                    const paddedNumericalPart = numericalPart.padStart(maxFormattedItemCostLength, '0');
                    formattedItemCost = currencySymbol + paddedNumericalPart;
                    
                    let line = `   • ${item.calculation} ➜ &nbsp;&nbsp;**${formattedItemCost}**`;
                    const modelName = item.modelNameForTooltip;
                    let modelNameDisplay = ""; // Initialize for the model name part of the string

                    if (modelName) { // Make sure modelName is there
                        const isDiscounted = item.description && item.description.toLowerCase().includes("discounted");
                        const isUnknown = modelName === "unknown-model";

                        if (isDiscounted) {
                            modelNameDisplay = `(${t('statusBar.discounted')} | ${isUnknown ? t('statusBar.unknownModel') : modelName})`;
                        } else if (isUnknown) {
                            modelNameDisplay = `(${t('statusBar.unknownModel')})`;
                        } else {
                            modelNameDisplay = `(${modelName})`;
                        }
                    }
                    // If modelName was undefined or null, modelNameDisplay remains empty.

                    if (modelNameDisplay) { // Only add spacing and display string if it's not empty
                        const desiredTotalWidth = 70; // Adjust as needed for good visual alignment
                        const currentLineWidth = line.replace(/\*\*/g, '').replace(/&nbsp;/g, ' ').length; // Approx length without markdown & html spaces
                        const modelNameDisplayLength = modelNameDisplay.replace(/&nbsp;/g, ' ').length;
                        const spacesNeeded = Math.max(1, desiredTotalWidth - currentLineWidth - modelNameDisplayLength);
                        line += ' '.repeat(spacesNeeded) + `&nbsp;&nbsp;&nbsp;&nbsp;${modelNameDisplay}`;
                    }
                    contentLines.push(formatTooltipLine(line));

                } else {
                    // Fallback for items without a description (should be rare but handle it)
                    const itemCost = parseFloat(item.totalDollars.replace('$', ''));
                    let formattedItemCost = await convertAndFormatCurrency(itemCost);

                    // Pad the numerical part of the formattedItemCost
                    const currencySymbol = formattedItemCost.match(/^[^0-9-.\\,]*/)?.[0] || "";
                    const numericalPart = formattedItemCost.substring(currencySymbol.length);
                    const paddedNumericalPart = numericalPart.padStart(maxFormattedItemCostLength, '0');
                    formattedItemCost = currencySymbol + paddedNumericalPart;
                    
                    // Use a generic calculation string if item.calculation is also missing, or the original if available
                    const calculationString = item.calculation || t('statusBar.unknownItem'); 
                    contentLines.push(formatTooltipLine(`   • ${calculationString} ➜ &nbsp;&nbsp;**${formattedItemCost}**`));
                }
            }

            if (activeMonthData.usageBasedPricing.midMonthPayment > 0) {
                const formattedMidMonthPayment = await convertAndFormatCurrency(activeMonthData.usageBasedPricing.midMonthPayment);
                contentLines.push(
                    '',
                    formatTooltipLine(t('statusBar.youHavePaid', { amount: formattedMidMonthPayment }))
                );
            }

            const formattedFinalCost = await convertAndFormatCurrency(actualTotalCost);
            contentLines.push(
                '',
                formatTooltipLine(`💳 ${t('statusBar.totalCost')}: ${formattedFinalCost}`)
            );

            // Update costText for status bar here, using actual total cost
            costText = ` $(credit-card) ${formattedFinalCost}`;

            // Add spending notification check
            if (usageStatus.isEnabled) {
                setTimeout(() => {
                    checkAndNotifySpending(actualTotalCost); // Check spending based on actual total cost
                }, 1000);
            }
        } else {
            contentLines.push(`   ℹ️ ${t('statusBar.noUsageDataAvailable')}`);
        }

        // Calculate separator width based on content
        const maxWidth = getMaxLineWidth(contentLines);
        const separator = createSeparator(maxWidth);

        // Create final tooltip content with Last Updated at the bottom
        // Filter out the metadata line before creating the final tooltip
        const visibleContentLines = contentLines.filter(line => !line.includes('__USD_USAGE_DATA__'));
        
        const tooltipLines = [
            title,
            separator,
            ...visibleContentLines.slice(1),
            '',
            formatTooltipLine(`🕒 ${t('time.lastUpdated')}: ${new Date().toLocaleString()}`),
        ];

        // Update usage based percent for notifications
        usageBasedPercent = usageStatus.isEnabled ? usageBasedPercent : 0;
        
        log('[Status Bar] Updating status bar with new stats...');
        statusBarItem.text = `$(graph)${totalUsageText}`;
        statusBarItem.tooltip = await createMarkdownTooltip(tooltipLines, false, contentLines);
        statusBarItem.show();
        log('[Stats] Stats update completed successfully');

        // Show notifications after ensuring status bar is visible（高级模型阈值用 API 池百分比）
        if (usageStatus.isEnabled) {
            setTimeout(() => {
                checkAndNotifyUsage({
                    percentage: advancedModelsPercent,
                    type: 'premium'
                });
                if (advancedModelsPercent >= 100) {
                    checkAndNotifyUsage({
                        percentage: usageBasedPercent,
                        type: 'usage-based',
                        limit: usageStatus.limit,
                        premiumPercentage: advancedModelsPercent
                    });
                }
                if (activeMonthData.usageBasedPricing.hasUnpaidMidMonthInvoice) {
                    checkAndNotifyUnpaidInvoice(token);
                }
            }, 1000);
        } else {
            setTimeout(() => {
                checkAndNotifyUsage({
                    percentage: advancedModelsPercent,
                    type: 'premium'
                });
            }, 1000);
        }

        // The main notification for unknown models is now based on the populated detectedUnknownModels set
        if (!unknownModelNotificationShown && detectedUnknownModels.size > 0) {
            unknownModelNotificationShown = true; // Show once per session globally
            const unknownModelsString = Array.from(detectedUnknownModels).join(", ");
            log(`[Stats] Showing notification for aggregated unknown models: ${unknownModelsString}`);
            
            vscode.window.showInformationMessage(
                t('notifications.unknownModelsDetected', { models: unknownModelsString }),
                t('commands.createReport'),
                t('commands.openGitHubIssues')
            ).then(selection => {
                if (selection === t('commands.createReport')) {
                    vscode.commands.executeCommand('cursor-stats.createReport');
                } else if (selection === t('commands.openGitHubIssues')) {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/Dwtexe/cursor-stats/issues/new'));
                }
            });
        }
    } catch (error: any) {
        const errorCount = incrementConsecutiveErrorCount();
        log(`[Critical] API error: ${error.message}`, true);
        log('[Status Bar] Status bar visibility updated after error');
    }
}
