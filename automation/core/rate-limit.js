// Auto-extracted from automation-functions.js
// NOTE: verify imports below and adjust as needed.

const { randomDelay } = require('../human/delay');
const { logAction } = require('../util/log');

async function checkForRateLimiting(page) { // Added async keyword
    const rateLimitSelectors = [
        'text="You have reached the commercial use limit"',
        'text="Security Verification"',
        'text="Please verify you are a real person"',
        'text="Let\'s do a quick security check"'
    ];
    for (const selector of rateLimitSelectors) {
        const isRateLimited = await page.$(selector);
        if (isRateLimited) {
            logAction('Rate limiting detected - pausing automation');
            logAction('Please solve the security challenge manually...');
            await randomDelay(120000, 180000);
            return true;
        }
    }
    return false;
}

module.exports = { checkForRateLimiting };