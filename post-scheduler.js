// post-scheduler.js - Frontend JavaScript for LinkedIn Post Scheduling
const LEGACY_POST_STORAGE_KEY = 'linkedin-scheduled-posts';

class LinkedInPostScheduler {
  constructor() {
    this.posts = [];
    this.visibleAccountId = window.LinkedInAccountContext?.getActiveAccountId?.() || null;
    this.storageReady = this.init();
  }

  async init() {
    await this.loadStoredPosts();
    this.setupEventListeners();
    this.renderPosts();
  }

  setupEventListeners() {
    // Post creation form
    document.getElementById('create-post-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.schedulePostForPublishing();
    });

    // Preview post button
    document.getElementById('preview-post-btn')?.addEventListener('click', () => {
      this.previewPost();
    });

    // Schedule post button
    document.getElementById('schedule-post-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.schedulePostForPublishing();
    });

    // Import posts from CSV/JSON
    document.getElementById('import-posts-btn')?.addEventListener('click', () => {
      this.importPosts();
    });

    // Export posts
    document.getElementById('export-posts-btn')?.addEventListener('click', () => {
      this.exportPosts();
    });

    // Character counter
    document.getElementById('post-content')?.addEventListener('input', (e) => {
      this.updateCharacterCount(e.target.value);
    });

    // Date/time validation
    document.getElementById('scheduled-date')?.addEventListener('change', () => {
      this.validateScheduleDate();
    });

    document.getElementById('scheduled-time')?.addEventListener('change', () => {
      this.validateScheduleDate();
    });

    document.addEventListener('connect-ability:active-linkedin-account-changed', async (event) => {
      this.visibleAccountId = event.detail?.accountId || window.LinkedInAccountContext?.getActiveAccountId?.() || null;
      await this.loadStoredPosts();
      this.renderPosts();
    });
  }

  createPost() {
    const form = document.getElementById('create-post-form');
    const formData = new FormData(form);
    
    const post = {
      id: Date.now().toString(),
      content: formData.get('content').trim(),
      scheduledDate: formData.get('scheduledDate'),
      scheduledTime: formData.get('scheduledTime'),
      status: 'pending',
      createdAt: new Date().toISOString(),
      hashtags: this.extractHashtags(formData.get('content')),
      mentions: this.extractMentions(formData.get('content')),
      includeImage: formData.get('includeImage') === 'on',
      imagePath: formData.get('imagePath') || null,
      postType: formData.get('postType') || 'text',
      visibility: formData.get('visibility') || 'public'
    };

    // Validate post
    if (!this.validatePost(post)) {
      return;
    }

    // Add to posts array
    this.posts.push(post);
    void this.savePostsToStorage({ syncRemote: true });
    this.renderPosts();
    
    // Clear form
    form.reset();
    this.updateCharacterCount('');
    
    this.showNotification(`Post scheduled for ${this.formatDateTime(post.scheduledDate, post.scheduledTime)}`, 'success');
  }

  validatePost(post, options = {}) {
    const immediate = !!options.immediate;
    const errors = [];

    // Content validation
    if (!post.content || post.content.length < 1) {
      errors.push('Post content is required');
    }

    if (post.content.length > 3000) {
      errors.push('Post content exceeds 3000 character limit');
    }

    // Date validation only for scheduled mode
    if (!immediate) {
      if (!post.scheduledDate || !post.scheduledTime) {
        errors.push('Scheduled date and time are required');
      } else {
        const scheduledDateTime = new Date(`${post.scheduledDate}T${post.scheduledTime}`);
        const now = new Date();
        const maxFutureDate = new Date();
        maxFutureDate.setMonth(maxFutureDate.getMonth() + 3); // 3 months max

        if (scheduledDateTime <= now) {
          errors.push('Scheduled time must be in the future');
        }

        if (scheduledDateTime > maxFutureDate) {
          errors.push('Cannot schedule posts more than 3 months in advance');
        }
      }
    }

    // Show errors if any
    if (errors.length > 0) {
      this.showNotification(errors.join('\n'), 'error');
      return false;
    }

    return true;
  }

  extractHashtags(content) {
    const hashtagRegex = /#[\w\u0590-\u05ff]+/g;
    return content.match(hashtagRegex) || [];
  }

  extractMentions(content) {
    const mentionRegex = /@[\w\u0590-\u05ff]+/g;
    return content.match(mentionRegex) || [];
  }

  updateCharacterCount(content) {
    const counter = document.getElementById('character-counter');
    if (counter) {
      const count = content.length;
      const maxCount = 3000;
      counter.textContent = `${count}/${maxCount}`;
      
      // Update styling based on character count
      if (count > maxCount * 0.9) {
        counter.className = 'character-counter warning';
      } else if (count > maxCount) {
        counter.className = 'character-counter error';
      } else {
        counter.className = 'character-counter';
      }
    }
  }

  validateScheduleDate() {
    const dateInput = document.getElementById('scheduled-date');
    const timeInput = document.getElementById('scheduled-time');
    const warningElement = document.getElementById('schedule-warning');
    
    if (!dateInput.value || !timeInput.value) return;
    
    const scheduledDateTime = new Date(`${dateInput.value}T${timeInput.value}`);
    const now = new Date();
    const timeDiff = scheduledDateTime - now;
    
    if (timeDiff <= 0) {
      warningElement.textContent = 'Scheduled time must be in the future';
      warningElement.className = 'schedule-warning error';
    } else if (timeDiff < 5 * 60 * 1000) { // Less than 5 minutes
      warningElement.textContent = 'Warning: Very short scheduling time (less than 5 minutes)';
      warningElement.className = 'schedule-warning warning';
    } else {
      warningElement.textContent = `Post will be published in ${this.getTimeDifference(timeDiff)}`;
      warningElement.className = 'schedule-warning success';
    }
  }

  getTimeDifference(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }

  renderPosts() {
    const container = document.getElementById('scheduled-posts-list');
    if (!container) return;

    if (this.posts.length === 0) {
      container.innerHTML = '<div class="inbox-empty"><p>No scheduled posts yet. Create your first post above.</p></div>';
      return;
    }

    // Sort posts by scheduled date
    const sortedPosts = [...this.posts].sort((a, b) => {
      const dateA = this.getScheduledDateTime(a) || new Date(a.createdAt || 0);
      const dateB = this.getScheduledDateTime(b) || new Date(b.createdAt || 0);
      return dateA - dateB;
    });

    container.innerHTML = sortedPosts.map(post => this.renderPostCard(post)).join('');
    
    // Add event listeners to post cards
    this.attachPostCardListeners();
  }

  renderPostCard(post) {
    const scheduledDateTime = this.getScheduledDateTime(post);
    const isOverdue = scheduledDateTime ? scheduledDateTime < new Date() : false;
    const statusClass = this.getStatusClass(post.status, isOverdue);
    const accountLabel = post.accountName || 'Default profile';
    const agentLabel = post.agentName || '';
    const planLabel = post.planName || '';
    const planTheme = post.contentTheme || post.contentPillar || '';
    
    return `
      <div class="post-card ${statusClass}" data-post-id="${post.id}">
        <div class="post-card-header">
          <div class="post-status">
            <span class="status-badge ${post.status}">${this.getStatusText(post.status, isOverdue)}</span>
            <span class="post-date">${this.formatDateTime(post.scheduledDate, post.scheduledTime)}</span>
          </div>
          <div class="post-actions">
            <button class="btn-icon edit-post" title="Edit Post"><span class="material-symbols-outlined" style="font-size:16px">edit</span></button>
            <button class="btn-icon preview-post" title="Preview Post"><span class="material-symbols-outlined" style="font-size:16px">visibility</span></button>
            <button class="btn-icon duplicate-post" title="Duplicate Post"><span class="material-symbols-outlined" style="font-size:16px">content_copy</span></button>
            <button class="btn-icon delete-post" title="Delete Post"><span class="material-symbols-outlined" style="font-size:16px">delete</span></button>
          </div>
        </div>
        
        <div class="post-content">
          <p class="post-text">${this.formatPostContent(post.content)}</p>
          ${post.hashtags.length > 0 ? `
            <div class="post-hashtags">
              ${post.hashtags.map(tag => `<span class="hashtag">${tag}</span>`).join('')}
            </div>
          ` : ''}
          ${post.mentions.length > 0 ? `
            <div class="post-mentions">
              ${post.mentions.map(mention => `<span class="mention">${mention}</span>`).join('')}
            </div>
          ` : ''}
        </div>
        
        <div class="post-metadata">
          <div class="metadata-item">
            <span class="label">Profile:</span>
            <span class="value">${this.escapeHtml(accountLabel)}</span>
          </div>
          ${agentLabel ? `
            <div class="metadata-item">
              <span class="label">Agent:</span>
              <span class="value">${this.escapeHtml(agentLabel)}</span>
            </div>
          ` : ''}
          <div class="metadata-item">
            <span class="label">Type:</span>
            <span class="value">${post.postType}</span>
          </div>
          <div class="metadata-item">
            <span class="label">Visibility:</span>
            <span class="value">${post.visibility}</span>
          </div>
          ${planLabel ? `
            <div class="metadata-item">
              <span class="label">Plan:</span>
              <span class="value">${this.escapeHtml(planLabel)}</span>
            </div>
          ` : ''}
          ${planTheme ? `
            <div class="metadata-item">
              <span class="label">Theme:</span>
              <span class="value">${this.escapeHtml(planTheme)}</span>
            </div>
          ` : ''}
          ${post.includeImage ? `
            <div class="metadata-item">
              <span class="label">Image:</span>
              <span class="value">Included</span>
            </div>
          ` : ''}
        </div>
        
        ${post.status === 'pending' && !isOverdue ? `
          <div class="post-card-footer">
            <button class="btn btn-primary publish-now" data-post-id="${post.id}">
              Publish Now
            </button>
            <button class="btn btn-secondary reschedule" data-post-id="${post.id}">
              Reschedule
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  attachPostCardListeners() {
    // Edit post
    document.querySelectorAll('.edit-post').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.closest('.post-card').dataset.postId;
        void this.editPost(postId);
      });
    });

    // Preview post
    document.querySelectorAll('.preview-post').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.closest('.post-card').dataset.postId;
        this.previewPost(postId);
      });
    });

    // Duplicate post
    document.querySelectorAll('.duplicate-post').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.closest('.post-card').dataset.postId;
        void this.duplicatePost(postId);
      });
    });

    // Delete post
    document.querySelectorAll('.delete-post').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.closest('.post-card').dataset.postId;
        void this.deletePost(postId);
      });
    });

    // Publish now
    document.querySelectorAll('.publish-now').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.dataset.postId;
        this.publishPostNow(postId);
      });
    });

    // Reschedule
    document.querySelectorAll('.reschedule').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const postId = e.target.dataset.postId;
        this.reschedulePost(postId);
      });
    });
  }

  getStatusClass(status, isOverdue) {
    if (isOverdue && status === 'pending') return 'overdue';
    return status;
  }

  getStatusText(status, isOverdue) {
    if (isOverdue && status === 'pending') return 'Overdue';
    
    const statusTexts = {
      pending: 'Scheduled',
      publishing: 'Publishing...',
      scheduled: 'Scheduled',
      published: 'Published',
      failed: 'Failed',
      cancelled: 'Cancelled'
    };
    
    return statusTexts[status] || status;
  }

  formatPostContent(content) {
    // Limit display to first 200 characters
    if (content.length <= 200) return content;
    return content.substring(0, 200) + '...';
  }

  formatDateTime(date, time) {
    const dateTime = this.getScheduledDateTime({ scheduledDate: date, scheduledTime: time });
    return dateTime ? dateTime.toLocaleString() : 'Publish immediately';
  }

  publishPostNow(postId) {
    const post = this.posts.find(p => p.id === postId);
    if (!post) return;

    if (confirm(`Are you sure you want to publish "${post.content.substring(0, 50)}..." immediately?`)) {
      this.schedulePostForPublishing(post, true);
    }
  }

  schedulePostForPublishing(post = null, immediate = false) {
    const activeLinkedInAccount = window.LinkedInAccountContext?.getActiveAccount?.() || null;
    this.visibleAccountId = activeLinkedInAccount?.id || this.visibleAccountId || null;
    // If called without args (from the main schedule button), grab form data
    if (!post) {
      const form = document.getElementById('create-post-form');
      const formData = new FormData(form);
      const sendNowSelected = document.getElementById('send-now')?.checked;
      immediate = immediate || !!sendNowSelected;
      const newPost = {
        id: Date.now().toString(),
        content: formData.get('content').trim(),
        scheduledDate: immediate ? null : formData.get('scheduledDate'),
        scheduledTime: immediate ? null : formData.get('scheduledTime'),
        status: 'pending',
        createdAt: new Date().toISOString(),
        hashtags: this.extractHashtags(formData.get('content')),
        mentions: this.extractMentions(formData.get('content')),
        includeImage: document.getElementById('include-image').checked,
        imagePath: formData.get('imagePath') || null,
        postType: formData.get('postType') || 'text',
        visibility: formData.get('visibility') || 'public',
        accountId: activeLinkedInAccount?.id || null,
        accountName: activeLinkedInAccount?.name || activeLinkedInAccount?.email || null
      };

      if (!this.validatePost(newPost, { immediate })) {
        return; // Stop if validation fails
      }

      this.posts.push(newPost);
      post = newPost; // Assign the newly created post to be processed
    }

    // Update post status
    post.status = 'publishing';
    void this.savePostsToStorage();
    this.renderPosts();

    // Send to main process for real browser automation.
    window.electronAPI.publishLinkedInPost({
      postId: post.id,
      accountId: post.accountId || activeLinkedInAccount?.id || null,
      content: post.content,
      scheduledDate: immediate ? null : post.scheduledDate,
      scheduledTime: immediate ? null : post.scheduledTime,
      immediate,
      includeImage: post.includeImage,
      imagePath: post.imagePath,
      visibility: post.visibility
    });
  }

  async editPost(postId) {
    const post = this.posts.find(p => p.id === postId);
    if (!post) return;

    // Populate form with post data
    document.getElementById('post-content').value = post.content;
    document.getElementById('scheduled-date').value = post.scheduledDate;
    document.getElementById('scheduled-time').value = post.scheduledTime;
    document.getElementById('post-type').value = post.postType;
    document.getElementById('post-visibility').value = post.visibility;
    document.getElementById('include-image').checked = post.includeImage;

    // Remove post from list (will be re-added when form is submitted)
    this.posts = this.posts.filter(p => p.id !== postId);
    await this.savePostsToStorage({ syncRemote: !!post.linkedInResourceKey });
    this.renderPosts();

    // Scroll to form
    document.getElementById('create-post-form').scrollIntoView({ behavior: 'smooth' });
    
    this.updateCharacterCount(post.content);
  }

  async duplicatePost(postId) {
    const post = this.posts.find(p => p.id === postId);
    if (!post) return;

    // Create new post with same content but new schedule time
    const newDateTime = new Date();
    newDateTime.setHours(newDateTime.getHours() + 1); // Default to 1 hour from now

    const duplicatedPost = {
      ...post,
      id: Date.now().toString(),
      scheduledDate: newDateTime.toISOString().split('T')[0],
      scheduledTime: newDateTime.toTimeString().substring(0, 5),
      status: 'pending',
      createdAt: new Date().toISOString(),
      deliveryStrategy: 'local_queue',
      linkedInResourceKey: null,
      linkedInScheduledAt: null,
      linkedInLastSyncedAt: null,
      linkedInSyncError: null,
      publishedAt: null,
      error: null
    };

    this.posts.push(duplicatedPost);
    await this.savePostsToStorage({ syncRemote: true });
    this.renderPosts();
    
    this.showNotification('Post duplicated successfully', 'success');
  }

  async deletePost(postId) {
    const post = this.posts.find(p => p.id === postId);
    if (!post) return;

    if (confirm(`Are you sure you want to delete the post "${post.content.substring(0, 50)}..."?`)) {
      this.posts = this.posts.filter(p => p.id !== postId);
      await this.savePostsToStorage({ syncRemote: !!post.linkedInResourceKey });
      this.renderPosts();
      
      this.showNotification('Post deleted successfully', 'success');
    }
  }

  previewPost(postId = null) {
    let post;
    
    if (postId) {
      post = this.posts.find(p => p.id === postId);
    } else {
      // Create preview from current form data
      const form = document.getElementById('create-post-form');
      const formData = new FormData(form);
      
      post = {
        content: formData.get('content'),
        scheduledDate: formData.get('scheduledDate'),
        scheduledTime: formData.get('scheduledTime'),
        postType: formData.get('postType') || 'text',
        visibility: formData.get('visibility') || 'public',
        includeImage: formData.get('includeImage') === 'on',
        hashtags: this.extractHashtags(formData.get('content')),
        mentions: this.extractMentions(formData.get('content'))
      };
    }

    if (!post || !post.content) {
      this.showNotification('No content to preview', 'warning');
      return;
    }

    this.showPreviewModal(post);
  }

  showPreviewModal(post) {
    const modal = document.getElementById('preview-modal') || this.createPreviewModal();
    const previewContent = modal.querySelector('.preview-content');
    
    previewContent.innerHTML = `
      <div class="linkedin-post-preview">
        <div class="post-header">
          <div class="user-info">
            <div class="avatar">U</div>
            <div class="user-details">
              <div class="user-name">Your Name</div>
              <div class="post-meta">
                Scheduled for ${this.formatDateTime(post.scheduledDate, post.scheduledTime)} • 
                <span class="visibility">${post.visibility}</span>
              </div>
            </div>
          </div>
        </div>
        
        <div class="post-body">
          <p class="post-text">${post.content.replace(/\n/g, '<br>')}</p>
          
          ${post.includeImage ? `
            <div class="post-image-placeholder">
              <div class="image-icon">🖼️</div>
              <p>Image will be attached</p>
            </div>
          ` : ''}
        </div>
        
        <div class="post-footer">
          <div class="engagement-buttons">
            <button class="engagement-btn">👍 Like</button>
            <button class="engagement-btn">💬 Comment</button>
            <button class="engagement-btn">🔁 Repost</button>
            <button class="engagement-btn">📤 Send</button>
          </div>
        </div>
        
        ${post.hashtags.length > 0 || post.mentions.length > 0 ? `
          <div class="post-tags">
            ${post.hashtags.length > 0 ? `
              <div class="hashtags">
                <strong>Hashtags:</strong> ${post.hashtags.join(', ')}
              </div>
            ` : ''}
            ${post.mentions.length > 0 ? `
              <div class="mentions">
                <strong>Mentions:</strong> ${post.mentions.join(', ')}
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
    
    modal.style.display = 'flex';
  }

  createPreviewModal() {
    const modal = document.createElement('div');
    modal.id = 'preview-modal';
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>Post Preview</h3>
          <button class="modal-close">&times;</button>
        </div>
        <div class="preview-content"></div>
        <div class="modal-footer">
          <button class="btn btn-secondary close-preview">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Add event listeners
    modal.querySelector('.modal-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    
    modal.querySelector('.close-preview').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
    
    return modal;
  }

  async loadStoredPosts() {
    try {
      const accountId = window.LinkedInAccountContext?.getActiveAccountId?.() || this.visibleAccountId || null;
      this.visibleAccountId = accountId;
      if (window.electronAPI?.getScheduledPosts) {
        const result = await window.electronAPI.getScheduledPosts({ accountId });
        if (result?.ok && Array.isArray(result.posts)) {
          this.posts = result.posts;
          return;
        }
      }

      this.posts = this.loadLegacyPosts();
    } catch (error) {
      console.error('Error loading posts from storage:', error);
      this.posts = this.loadLegacyPosts();
    }
  }

  async savePostsToStorage(options = {}) {
    try {
      const accountId = this.visibleAccountId || window.LinkedInAccountContext?.getActiveAccountId?.() || null;
      this.visibleAccountId = accountId;
      if (window.electronAPI?.saveScheduledPosts) {
        const result = await window.electronAPI.saveScheduledPosts(this.posts, {
          accountId,
          syncRemote: !!options.syncRemote
        });
        if (result?.ok && Array.isArray(result.posts)) {
          this.posts = result.posts;
          if (result.syncSummary?.warnings?.length) {
            console.warn('Scheduled post sync warnings:', result.syncSummary.warnings);
          }
          return true;
        }

        throw new Error(result?.error || 'Failed to persist scheduled posts');
      }

      localStorage.setItem(LEGACY_POST_STORAGE_KEY, JSON.stringify(this.posts));
      return true;
    } catch (error) {
      console.error('Error saving posts to storage:', error);
      try {
        localStorage.setItem(LEGACY_POST_STORAGE_KEY, JSON.stringify(this.posts));
      } catch (_fallbackError) {
        // Ignore fallback persistence failures after logging the primary error.
      }
      return false;
    }
  }

  loadLegacyPosts() {
    try {
      const stored = localStorage.getItem(LEGACY_POST_STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.error('Error loading legacy post storage:', error);
      return [];
    }
  }

  clearLegacyPosts() {
    try {
      localStorage.removeItem(LEGACY_POST_STORAGE_KEY);
    } catch (error) {
      console.warn('Failed to clear legacy scheduled post storage:', error);
    }
  }

  importPosts() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          let importedPosts;
          
          if (file.name.endsWith('.json')) {
            importedPosts = JSON.parse(e.target.result);
          } else if (file.name.endsWith('.csv')) {
            importedPosts = this.parseCSV(e.target.result);
          }
          
          if (importedPosts && Array.isArray(importedPosts)) {
            const activeLinkedInAccount = window.LinkedInAccountContext?.getActiveAccount?.() || null;
            // Add unique IDs and validate
            importedPosts.forEach(post => {
              post.id = Date.now().toString() + Math.random();
              post.status = 'pending';
              post.createdAt = new Date().toISOString();
              post.deliveryStrategy = 'local_queue';
              post.linkedInResourceKey = null;
              post.linkedInScheduledAt = null;
              post.linkedInLastSyncedAt = null;
              post.linkedInSyncError = null;
              post.publishedAt = null;
              post.error = null;
              post.accountId = activeLinkedInAccount?.id || this.visibleAccountId || null;
              post.accountName = activeLinkedInAccount?.name || activeLinkedInAccount?.email || null;
            });
            
            this.posts = [...this.posts, ...importedPosts];
            void this.savePostsToStorage({ syncRemote: true });
            this.renderPosts();
            
            this.showNotification(`Imported ${importedPosts.length} posts successfully`, 'success');
          }
        } catch (error) {
          this.showNotification('Error importing posts: ' + error.message, 'error');
        }
      };
      
      reader.readAsText(file);
    };
    
    input.click();
  }

  parseCSV(csvText) {
    const lines = csvText.split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const posts = [];
    
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      
      const values = lines[i].split(',').map(v => v.trim().replace(/^"(.*)"$/, '$1'));
      const post = {};
      
      headers.forEach((header, index) => {
        post[header] = values[index] || '';
      });
      
      // Ensure required fields exist
      if (post.content && post.scheduledDate && post.scheduledTime) {
        posts.push(post);
      }
    }
    
    return posts;
  }

  exportPosts() {
    if (this.posts.length === 0) {
      this.showNotification('No posts to export', 'warning');
      return;
    }

    const dataStr = JSON.stringify(this.posts, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    
    const link = document.createElement('a');
    link.href = URL.createObjectURL(dataBlob);
    link.download = `linkedin-posts-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    
    this.showNotification(`Exported ${this.posts.length} posts successfully`, 'success');
  }

  escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Remove after 5 seconds
    setTimeout(() => {
      notification.remove();
    }, 5000);
  }

  // Initialize timers for scheduled posts
  initializeScheduler() {
    setInterval(() => {
      this.checkScheduledPosts();
    }, 60000); // Check every minute
  }

  checkScheduledPosts() {
    const now = new Date();
      const pendingPosts = this.posts.filter(post => {
        const scheduledTime = this.getScheduledDateTime(post);
        if (!scheduledTime) return false;
        return post.status === 'pending' && scheduledTime <= now && !post.linkedInResourceKey;
      });

    pendingPosts.forEach(post => {
      this.schedulePostForPublishing(post);
    });
  }

  getScheduledDateTime(post) {
    if (!post?.scheduledDate || !post?.scheduledTime) {
      return null;
    }

    const scheduledDateTime = new Date(`${post.scheduledDate}T${post.scheduledTime}`);
    return Number.isNaN(scheduledDateTime.getTime()) ? null : scheduledDateTime;
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', async () => {
  const scheduler = new LinkedInPostScheduler();
  await scheduler.storageReady;
  scheduler.initializeScheduler();
  
  // Make scheduler available globally
  window.linkedInPostScheduler = scheduler;
  
  // Listen for responses from main process using the new API
  if (window.electronAPI && window.electronAPI.onPostPublished) {
    window.electronAPI.onPostPublished(async (result) => {
      const {
        postId,
        success,
        error,
        outcome,
        deliveryStrategy,
        linkedInResourceKey,
        linkedInScheduledAt
      } = result;
      const scheduler = window.linkedInPostScheduler;
      const post = scheduler.posts.find(p => p.id === postId);
      
      if (post) {
        post.status = success
          ? (outcome === 'scheduled' ? 'scheduled' : 'published')
          : 'failed';
        if (error) post.error = error;
        if (success && outcome === 'published') {
          post.publishedAt = new Date().toISOString();
        }
        if (success && outcome === 'scheduled') {
          post.publishedAt = null;
          post.deliveryStrategy = deliveryStrategy || 'linkedin_scheduled';
          post.linkedInResourceKey = linkedInResourceKey || null;
          post.linkedInScheduledAt = linkedInScheduledAt || null;
          post.linkedInLastSyncedAt = new Date().toISOString();
          post.linkedInSyncError = null;
          post.error = null;
        }
        
        await scheduler.savePostsToStorage();
        scheduler.renderPosts();
        
        const message = success 
          ? (outcome === 'scheduled' ? 'Post scheduled on LinkedIn successfully!' : 'Post published successfully!')
          : `Failed to publish post: ${error}`;
        const type = success ? 'success' : 'error';
        
        scheduler.showNotification(message, type);
      }
    });
  }
});
