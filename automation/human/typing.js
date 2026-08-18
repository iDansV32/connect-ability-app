const { getTypingDelay } = require('./delay');

/**
 * Human-like typing with realistic mistakes and corrections
 * @param {Page} page - Playwright page object
 * @param {string} selector - CSS selector for the input element
 * @param {string} text - Text to type
 */
async function humanType(page, selector, text) {
  try {
    // Clear existing text first
    await page.fill(selector, '');
    
    // Type with human-like delays and occasional mistakes
    for (let i = 0; i < text.length; i++) {
      // 8% chance of making a typo
      if (Math.random() < 0.08 && i > 0 && i < text.length - 1) {
        // Make a typo
        const wrongChars = 'abcdefghijklmnopqrstuvwxyz';
        const wrongChar = wrongChars[Math.floor(Math.random() * wrongChars.length)];
        await page.type(selector, wrongChar, { delay: getTypingDelay() });
        
        // Pause as if realizing the mistake
        await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
        
        // Backspace to correct it
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      }
      
      // Type the actual character
      await page.type(selector, text[i], { delay: getTypingDelay() });
      
      // 15% chance of a micro-pause (thinking)
      if (Math.random() < 0.15) {
        await new Promise(r => setTimeout(r, 200 + Math.random() * 800));
      }
      
      // 5% chance of longer pause (major thinking)
      if (Math.random() < 0.05) {
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
      }
    }
  } catch (error) {
    console.error('Error in humanType:', error);
    // Fallback to simple typing
    await page.type(selector, text, { delay: 100 });
  }
}

/**
 * Type with deliberate mistakes for even more human-like behavior
 * @param {Page} page - Playwright page object
 * @param {string} selector - CSS selector
 * @param {string} text - Text to type
 * @param {number} mistakeRate - Rate of mistakes (0-1)
 */
async function typeWithMistakes(page, selector, text, mistakeRate = 0.05) {
  await page.fill(selector, '');
  
  // Common typo patterns (adjacent keys on QWERTY keyboard)
  const typoMap = {
    'a': ['s', 'q', 'w'],
    'b': ['v', 'n', 'g'],
    'c': ['x', 'v', 'd'],
    'd': ['s', 'f', 'e', 'r', 'c'],
    'e': ['w', 'r', 'd', 's'],
    'f': ['d', 'g', 'r', 't', 'v'],
    'g': ['f', 'h', 't', 'y', 'b'],
    'h': ['g', 'j', 'y', 'u', 'n'],
    'i': ['u', 'o', 'k', 'j'],
    'j': ['h', 'k', 'u', 'i', 'n', 'm'],
    'k': ['j', 'l', 'i', 'o', 'm'],
    'l': ['k', 'o', 'p'],
    'm': ['n', 'j', 'k'],
    'n': ['b', 'm', 'h', 'j'],
    'o': ['i', 'p', 'l', 'k'],
    'p': ['o', 'l'],
    'q': ['w', 'a'],
    'r': ['e', 't', 'f', 'd'],
    's': ['a', 'd', 'w', 'e', 'x', 'z'],
    't': ['r', 'y', 'g', 'f'],
    'u': ['y', 'i', 'j', 'h'],
    'v': ['c', 'b', 'f', 'g'],
    'w': ['q', 'e', 'a', 's'],
    'x': ['z', 'c', 's', 'd'],
    'y': ['t', 'u', 'h', 'g'],
    'z': ['x', 'a', 's']
  };
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Decide if we should make a typo
    if (Math.random() < mistakeRate && i > 0 && i < text.length - 1) {
      const lowerChar = char.toLowerCase();
      
      // Get possible typo characters
      const possibleTypos = typoMap[lowerChar] || [];
      
      if (possibleTypos.length > 0) {
        // Type wrong character
        const typoChar = possibleTypos[Math.floor(Math.random() * possibleTypos.length)];
        const actualTypo = char === char.toUpperCase() ? typoChar.toUpperCase() : typoChar;
        
        await page.type(selector, actualTypo, { delay: getTypingDelay() });
        
        // Random delay before noticing the mistake
        await new Promise(r => setTimeout(r, 200 + Math.random() * 600));
        
        // Correct the mistake
        await page.keyboard.press('Backspace');
        await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
      }
    }
    
    // Type the correct character
    await page.type(selector, char, { delay: getTypingDelay() });
    
    // Natural pauses
    if (char === ' ') {
      // Slight pause after spaces
      await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
    } else if (char === '.' || char === ',' || char === '!' || char === '?') {
      // Longer pause after punctuation
      await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    }
  }
}

module.exports = {
  humanType,
  typeWithMistakes
};
