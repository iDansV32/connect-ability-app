// messaging/composer.js
const { logAction, logError } = require('../util/log');
const { randomDelay, getTypingDelay } = require('../human/delay');
const { humanType } = require('../human/typing');
const { applyVariants, computeVariantKey } = require('./variant-engine');
const { stealthClick } = require('../mouse/stealth-click');

/**
 * Find message input box
 * @param {Page} page - Playwright page object
 * @returns {Promise<ElementHandle|null>} - Input element or null
 */
async function findMessageInput(page) {
  try {
    const inputSelectors = [
      'div[role="textbox"][contenteditable="true"]',
      'div.msg-form__contenteditable',
      'div.msg-form__msg-content-container [contenteditable="true"]',
      'textarea.msg-form__textarea',
      '.msg-messaging-form [contenteditable="true"]'
    ];
    
    for (const selector of inputSelectors) {
      const input = await page.$(selector);
      if (input) {
        const isVisible = await input.isVisible();
        if (isVisible) {
          logAction(`Found message input with selector: ${selector}`);
          return input;
        }
      }
    }
    
    return null;
  } catch (error) {
    logError(`Error finding message input: ${error.message}`, error);
    return null;
  }
}

/**
 * Type message with human-like behavior
 * @param {Page} page - Playwright page object
 * @param {ElementHandle} input - Input element
 * @param {string} message - Message to type
 * @returns {Promise<boolean>} - Success status
 */
async function typeMessage(page, input, message, options = {}) {
  try {
    logAction('Typing message with human-like behavior');
    
    // Click on input to focus
    if (options.strictStealth === true) {
      await stealthClick(page, input, options);
    } else {
      await input.click();
    }
    await randomDelay(500, 1000);
    
    // Clear any existing content
    await pressKeyChord(page, process.platform === 'darwin' ? 'Meta' : 'Control', 'a');
    await randomDelay(200, 400);
    
    // Type message character by character
    const lines = message.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      for (const char of line) {
        await page.keyboard.type(char);
        const delay = getTypingDelay();
        await page.waitForTimeout(delay);
      }
      
      // Add newline if not last line
      if (i < lines.length - 1) {
        await pressKeyChord(page, 'Shift', 'Enter');
        await randomDelay(300, 600);
      }
    }
    
    logAction('Message typed successfully');
    return true;
  } catch (error) {
    logError(`Error typing message: ${error.message}`, error);
    return false;
  }
}

async function pressKeyChord(page, modifier, key) {
  await page.keyboard.down(modifier);
  await randomDelay(40, 120);
  await page.keyboard.press(key);
  await randomDelay(40, 120);
  await page.keyboard.up(modifier);
}

/**
 * Personalize message with profile data, then expand any {variant A|variant B}
 * spintax blocks so every sent message has a slightly different surface.
 *
 * @param {string}   template    - Message template
 * @param {Object}   profileData - Profile information
 * @param {function} [rng]       - Optional RNG override for variant selection (default Math.random)
 * @returns {string} - Personalized + variant-expanded message
 */
function personalizeMessage(template, profileData, rng) {
  try {
    let personalized = template;

    // Replace placeholders (case-insensitive)
    const replacements = {
      '{firstName}': profileData?.firstName || 'there',
      '{lastName}': profileData?.lastName || '',
      '{fullName}': profileData?.fullName || profileData?.firstName || 'there',
      '{company}': profileData?.company || 'your company',
      '{title}': profileData?.title || profileData?.position || 'your role',
      '{position}': profileData?.position || profileData?.title || 'your role'
    };

    for (const [placeholder, value] of Object.entries(replacements)) {
      const regex = new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'gi');
      personalized = personalized.replace(regex, value);
    }

    // Also handle template syntax {{ variable }}
    personalized = personalized
      .replace(/{{\s*firstName\s*}}/gi, profileData?.firstName || 'there')
      .replace(/{{\s*lastName\s*}}/gi, profileData?.lastName || '')
      .replace(/{{\s*name\s*}}/gi, profileData?.firstName || 'there')
      .replace(/{{\s*company\s*}}/gi, profileData?.company || 'your company')
      .replace(/{{\s*title\s*}}/gi, profileData?.title || 'your role');

    // Expand {variant A|variant B|...} blocks after placeholder substitution so
    // the chosen variant already contains the resolved profile values.
    personalized = applyVariants(personalized, rng);

    logAction(`Message personalized for ${profileData?.firstName || 'profile'}`);
    return personalized;
  } catch (error) {
    logError(`Error personalizing message: ${error.message}`, error);
    return template;
  }
}

/**
 * Get message templates
 * @param {string} type - Template type
 * @returns {string} - Message template
 */
function getMessageTemplate(type) {
  const templates = {
    introduction: `Hi {firstName},

I hope this message finds you well. I noticed your experience in {title} at {company} and wanted to reach out.

Best regards`,
    
    followUp: `Hi {firstName},

I wanted to follow up on our previous conversation. Hope you're having a great week!

Best regards`,
    
    eventInvitation: `Hi {firstName},

I wanted to reach out about an upcoming event that might interest you given your work at {company}.

Best regards`,
    
    thankYou: `Hi {firstName},

Thank you for connecting! I appreciate you taking the time.

Best regards`,
    
    custom: `Hi {firstName},

I hope this message finds you well. I noticed your experience in {title} at {company} and wanted to reach out.

Best regards`
  };
  
  return templates[type] || templates.custom;
}

module.exports = {
  findMessageInput,
  pressKeyChord,
  typeMessage,
  personalizeMessage,
  getMessageTemplate
};
