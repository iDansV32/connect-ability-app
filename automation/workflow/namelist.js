// ============================================
// workflow/namelist.js - NEW FILE
// ============================================
const { logAction, logError } = require('../util/log');
const { writeJsonFileAtomic } = require('../../connect-documents');

function calculateNameMatchScore(searchedName, extractedName) {
  if (!searchedName || !extractedName) return 0;
  
  const normalize = (name) => name.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const searchNormalized = normalize(searchedName);
  const extractedNormalized = normalize(extractedName);
  
  if (searchNormalized === extractedNormalized) {
    return 1.0;
  }
  
  const searchWords = searchNormalized.split(' ').filter(w => w.length > 1);
  const extractedWords = extractedNormalized.split(' ').filter(w => w.length > 1);
  
  let matchingWords = 0;
  let totalWords = Math.max(searchWords.length, extractedWords.length);
  
  for (const searchWord of searchWords) {
    for (const extractedWord of extractedWords) {
      if (searchWord === extractedWord) {
        matchingWords++;
        break;
      }
      else if (searchWord.length >= 4 && extractedWord.length >= 4) {
        if (searchWord.includes(extractedWord) || extractedWord.includes(searchWord)) {
          matchingWords += 0.7;
          break;
        }
      }
    }
  }
  
  const wordScore = matchingWords / totalWords;
  
  let nameBonus = 0;
  if (searchWords.length >= 2 && extractedWords.length >= 2) {
    const firstNameMatch = searchWords[0] === extractedWords[0];
    const lastNameMatch = searchWords[searchWords.length - 1] === extractedWords[extractedWords.length - 1];
    
    if (firstNameMatch && lastNameMatch) {
      nameBonus = 0.3;
    } else if (firstNameMatch || lastNameMatch) {
      nameBonus = 0.15;
    }
  }
  
  const finalScore = Math.min(wordScore + nameBonus, 1.0);
  logAction(`Match score: ${finalScore} (wordScore: ${wordScore}, nameBonus: ${nameBonus})`);
  
  return finalScore;
}

function storeNameMapping(searchedName, foundName, profileUrl) {
  try {
    const fs = require('fs');
    const path = require('path');
    const userHome = process.env.HOME || process.env.USERPROFILE;
    const documentsDir = path.join(userHome, 'Documents', 'Connect-Ability');
    const mappingPath = path.join(documentsDir, 'name-mappings.json');
    
    if (!fs.existsSync(documentsDir)) {
      fs.mkdirSync(documentsDir, { recursive: true });
    }
    
    let mappings = [];
    if (fs.existsSync(mappingPath)) {
      try {
        mappings = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
      } catch (error) {
        logError('Error reading name mappings file, starting fresh', error);
        mappings = [];
      }
    }
    
    const newMapping = {
      searchedName: searchedName,
      foundName: foundName,
      profileUrl: profileUrl,
      timestamp: new Date().toISOString()
    };
    
    const existingIndex = mappings.findIndex(m => 
      m.searchedName === searchedName && m.profileUrl === profileUrl
    );
    
    if (existingIndex >= 0) {
      mappings[existingIndex] = newMapping;
    } else {
      mappings.push(newMapping);
    }

    writeJsonFileAtomic(mappingPath, mappings);
    
    logAction(`Stored name mapping: "${searchedName}" -> "${foundName}"`);
    
  } catch (error) {
    logError(`Error storing name mapping: ${error.message}`, error);
  }
}

function parseNameList(nameListText) {
  if (!nameListText || typeof nameListText !== 'string') {
    return [];
  }
  
  const names = nameListText
    .split(/[\n,;|\t]/)
    .map(name => name.trim())
    .filter(name => name.length > 0)
    .filter(name => name.length > 2)
    .map(name => {
      return name
        .replace(/^\d+\.?\s*/, '')
        .replace(/^[-•*]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter(name => name.length > 2);
  
  return [...new Set(names)];
}

module.exports = {
  calculateNameMatchScore,
  storeNameMapping,
  parseNameList
};
