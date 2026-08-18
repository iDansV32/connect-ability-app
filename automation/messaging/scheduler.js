// messaging/scheduler.js
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { logAction, logError } = require('../util/log');
const { writeJsonFileAtomic } = require('../../connect-documents');

class MessageScheduler extends EventEmitter {
  constructor() {
    super();
    this.schedules = [];
    this.checkInterval = null;
    this.storePath = this._getStorePath();
    this._loadSchedules();
  }
  
  /**
   * Get storage path for schedules
   */
  _getStorePath() {
    const home = process.env.HOME || process.env.USERPROFILE;
    const dir = path.join(home, 'Documents', 'Connect-Ability');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'message-schedules.json');
  }
  
  /**
   * Load schedules from disk
   */
  _loadSchedules() {
    try {
      if (fs.existsSync(this.storePath)) {
        this.schedules = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        logAction(`Loaded ${this.schedules.length} scheduled messages`);
      }
    } catch (error) {
      logError(`Error loading schedules: ${error.message}`, error);
      this.schedules = [];
    }
  }
  
  /**
   * Save schedules to disk
   */
  _saveSchedules() {
    try {
      writeJsonFileAtomic(this.storePath, this.schedules);
    } catch (error) {
      logError(`Error saving schedules: ${error.message}`, error);
    }
  }
  
  /**
   * Schedule a message
   * @param {Object} schedule - Schedule object
   * @returns {string} - Schedule ID
   */
  scheduleMessage(schedule) {
    const id = Date.now().toString();
    const scheduledMessage = {
      id,
      profileUrls: schedule.profileUrls || [],
      message: schedule.message,
      scheduledTime: schedule.scheduledTime,
      status: 'pending',
      created: new Date().toISOString(),
      options: schedule.options || {}
    };
    
    this.schedules.push(scheduledMessage);
    this._saveSchedules();
    
    logAction(`Scheduled message ${id} for ${new Date(schedule.scheduledTime).toLocaleString()}`);
    return id;
  }
  
  /**
   * Cancel a scheduled message
   * @param {string} id - Schedule ID
   * @returns {boolean} - Success status
   */
  cancelSchedule(id) {
    const index = this.schedules.findIndex(s => s.id === id);
    if (index !== -1) {
      this.schedules[index].status = 'cancelled';
      this._saveSchedules();
      logAction(`Cancelled schedule ${id}`);
      return true;
    }
    return false;
  }
  
  /**
   * Edit a scheduled message
   * @param {string} id - Schedule ID
   * @param {Object} updates - Updates to apply
   * @returns {boolean} - Success status
   */
  editSchedule(id, updates) {
    const schedule = this.schedules.find(s => s.id === id);
    if (schedule && schedule.status === 'pending') {
      Object.assign(schedule, updates);
      schedule.modified = new Date().toISOString();
      this._saveSchedules();
      logAction(`Edited schedule ${id}`);
      return true;
    }
    return false;
  }
  
  /**
   * Get pending schedules
   * @returns {Array} - Pending schedules
   */
  getPendingSchedules() {
    return this.schedules.filter(s => s.status === 'pending');
  }
  
  /**
   * Get all schedules
   * @returns {Array} - All schedules
   */
  getAllSchedules() {
    return this.schedules;
  }
  
  /**
   * Check for due schedules
   */
  _checkSchedules() {
    const now = new Date();
    const pending = this.getPendingSchedules();
    
    for (const schedule of pending) {
      const scheduledTime = new Date(schedule.scheduledTime);
      if (scheduledTime <= now) {
        this._executeSchedule(schedule);
      }
    }
  }
  
  /**
   * Execute a scheduled message
   * @param {Object} schedule - Schedule to execute
   */
  _executeSchedule(schedule) {
    logAction(`Executing scheduled message ${schedule.id}`);
    
    schedule.status = 'executing';
    this._saveSchedules();
    
    // Emit event for the main process to handle
    this.emit('schedule-ready', {
      id: schedule.id,
      profileUrls: schedule.profileUrls,
      message: schedule.message,
      options: schedule.options
    });
    
    // Mark as sent after emitting
    setTimeout(() => {
      schedule.status = 'sent';
      schedule.sentAt = new Date().toISOString();
      this._saveSchedules();
    }, 1000);
  }
  
  /**
   * Start the scheduler
   */
  start() {
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => this._checkSchedules(), 30000); // Check every 30 seconds
      logAction('Message scheduler started');
      this._checkSchedules(); // Check immediately
    }
  }
  
  /**
   * Stop the scheduler
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logAction('Message scheduler stopped');
    }
  }
  
  /**
   * Clean up old schedules
   * @param {number} daysToKeep - Days to keep completed schedules
   */
  cleanupOldSchedules(daysToKeep = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const before = this.schedules.length;
    this.schedules = this.schedules.filter(s => {
      if (s.status === 'pending' || s.status === 'executing') {
        return true; // Keep pending/executing
      }
      const createdDate = new Date(s.created);
      return createdDate > cutoffDate;
    });
    
    const removed = before - this.schedules.length;
    if (removed > 0) {
      this._saveSchedules();
      logAction(`Cleaned up ${removed} old schedules`);
    }
  }
}

module.exports = new MessageScheduler();