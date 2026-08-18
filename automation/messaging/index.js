// index.js - Complete barrel exports with all functions
const path = require('path');

// Import all modules
const login = require('./core/login');
const challenges = require('./core/challenges');
const fingerprinting = require('./core/fingerprinting');
const rateLimit = require('./core/rate-limit');

const delay = require('./human/delay');
const scroll = require('./human/scroll');
const typing = require('./human/typing');

const moveNaturally = require('./mouse/move-naturally');

const wait = require('./helpers/wait');
const url = require('./helpers/url');
const data = require('./helpers/data');

const extract = require('./profile/extract');
const storage = require('./profile/storage');
const process = require('./profile/process');

const search = require('./search/search');
const pagination = require('./search/pagination');

const request = require('./connection/request');
const dialog = require('./connection/dialog');

const navigate = require('./activity/navigate');
const like = require('./activity/like');

const display = require('./ui/display');

const log = require('./util/log');

// Export everything
module.exports = {
  // Core functions
  loginToLinkedIn: login.loginToLinkedIn,
  handleSecurityChallenges: challenges.handleSecurityChallenges,
  setupFingerprinting: fingerprinting.setupFingerprinting,
  checkForRateLimiting: rateLimit.checkForRateLimiting,
  
  // Human functions
  randomDelay: delay.randomDelay,
  getTypingDelay: delay.getTypingDelay,
  readingDelay: delay.readingDelay,
  thinkingPause: delay.thinkingPause,
  reactionDelay: delay.reactionDelay,
  
  humanScroll: scroll.humanScroll,
  smoothScroll: scroll.smoothScroll,
  scrollToElement: scroll.scrollToElement,
  randomScroll: scroll.randomScroll,
  
  humanType: typing.humanType,
  typeWithMistakes: typing.typeWithMistakes,
  
  // Mouse functions
  moveMouseNaturally: moveNaturally.moveMouseNaturally,
  hoverElement: moveNaturally.hoverElement,
  
  // Helper functions
  waitForAnySelector: wait.waitForAnySelector,
  waitForElementAndClick: wait.waitForElementAndClick,
  waitUntilStable: wait.waitUntilStable,
  
  isLinkedInUrl: url.isLinkedInUrl,
  extractProfileId: url.extractProfileId,
  buildSearchUrl: url.buildSearchUrl,
  
  sanitizeText: data.sanitizeText,
  extractNumbers: data.extractNumbers,
  parseConnectionCount: data.parseConnectionCount,
  
  // Profile functions
  extractProfileDetails: extract.extractProfileDetails,
  extractEmailFromProfile: extract.extractEmailFromProfile,
  
  storeProfileAction: storage.storeProfileAction,
  backupProfileData: storage.backupProfileData,
  getStoredProfileDetails: storage.getStoredProfileDetails,
  normalizeProfileUrl: storage.normalizeProfileUrl,
  markProfileAsProcessed: storage.markProfileAsProcessed,
  processedProfilesCache: storage.processedProfilesCache,
  
  hasProfileBeenProcessed: process.hasProfileBeenProcessed,
  hasProfileAction: process.hasProfileAction,
  processProfile: process.processProfile,
  processProfileWithHistory: process.processProfileWithHistory,
  
  // Search functions
  searchForProfiles: search.searchForProfiles,
  extractProfileUrls: search.extractProfileUrls,
  humanLikeSearch: search.humanLikeSearch,
  
  searchForProfilesWithPagination: pagination.searchForProfilesWithPagination,
  checkForNextPage: pagination.checkForNextPage,
  goToNextPage: pagination.goToNextPage,
  
  // Connection functions
  sendConnectionRequest: request.sendConnectionRequest,
  handleConnectionPopups: request.handleConnectionPopups,
  
  handleConnectionDialog: dialog.handleConnectionDialog,
  clickConnectInDropdown: dialog.clickConnectInDropdown,
  
  // Activity functions
  navigateToActivityPage: navigate.navigateToActivityPage,
  checkForShowPostsButton: navigate.checkForShowPostsButton,
  
  enhancedLikePost: like.enhancedLikePost,
  verifyReaction: like.verifyReaction,
  processActivityPage: like.processActivityPage,
  
  // UI functions
  displayProfileInformation: display.displayProfileInformation,
  
  // Logging functions
  logAction: log.logAction,
  logError: log.logError,
  logWarning: log.logWarning,
  
  // Grouped exports for backward compatibility
  human: {
    randomDelay: delay.randomDelay,
    getTypingDelay: delay.getTypingDelay,
    readingDelay: delay.readingDelay,
    thinkingPause: delay.thinkingPause,
    reactionDelay: delay.reactionDelay,
    humanScroll: scroll.humanScroll,
    smoothScroll: scroll.smoothScroll,
    scrollToElement: scroll.scrollToElement,
    randomScroll: scroll.randomScroll,
    humanType: typing.humanType,
    typeWithMistakes: typing.typeWithMistakes
  },
  
  mouse: {
    moveMouseNaturally: moveNaturally.moveMouseNaturally,
    hoverElement: moveNaturally.hoverElement
  },
  
  helpers: {
    waitForAnySelector: wait.waitForAnySelector,
    waitForElementAndClick: wait.waitForElementAndClick,
    waitUntilStable: wait.waitUntilStable,
    isLinkedInUrl: url.isLinkedInUrl,
    extractProfileId: url.extractProfileId,
    buildSearchUrl: url.buildSearchUrl,
    sanitizeText: data.sanitizeText,
    extractNumbers: data.extractNumbers,
    parseConnectionCount: data.parseConnectionCount
  },
  
  profile: {
    extractProfileDetails: extract.extractProfileDetails,
    extractEmailFromProfile: extract.extractEmailFromProfile,
    storeProfileAction: storage.storeProfileAction,
    backupProfileData: storage.backupProfileData,
    getStoredProfileDetails: storage.getStoredProfileDetails,
    normalizeProfileUrl: storage.normalizeProfileUrl,
    markProfileAsProcessed: storage.markProfileAsProcessed,
    hasProfileBeenProcessed: process.hasProfileBeenProcessed,
    hasProfileAction: process.hasProfileAction,
    processProfile: process.processProfile,
    processProfileWithHistory: process.processProfileWithHistory
  },
  
  search: {
    searchForProfiles: search.searchForProfiles,
    extractProfileUrls: search.extractProfileUrls,
    humanLikeSearch: search.humanLikeSearch,
    searchForProfilesWithPagination: pagination.searchForProfilesWithPagination,
    checkForNextPage: pagination.checkForNextPage,
    goToNextPage: pagination.goToNextPage
  },
  
  connection: {
    sendConnectionRequest: request.sendConnectionRequest,
    handleConnectionPopups: request.handleConnectionPopups,
    handleConnectionDialog: dialog.handleConnectionDialog,
    clickConnectInDropdown: dialog.clickConnectInDropdown
  },
  
  activity: {
    navigateToActivityPage: navigate.navigateToActivityPage,
    checkForShowPostsButton: navigate.checkForShowPostsButton,
    enhancedLikePost: like.enhancedLikePost,
    verifyReaction: like.verifyReaction,
    processActivityPage: like.processActivityPage
  },
  
  ui: {
    displayProfileInformation: display.displayProfileInformation
  },
  
  util: {
    logAction: log.logAction,
    logError: log.logError,
    logWarning: log.logWarning
  }
};