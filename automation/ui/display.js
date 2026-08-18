// ui/display.js
const { logAction, logError } = require('../util/log');

/**
 * Display profile information in UI overlay
 * @param {Page} page - Playwright page object
 * @param {Object} profileDetails - Profile details to display
 * @returns {Promise<boolean>} - Success status
 */
async function displayProfileInformation(page, profileDetails) {
  try {
    // Add CSS for profile display
    await page.addStyleTag({
      content: `
        .profile-info-panel {
          position: fixed;
          top: 80px;
          right: 20px;
          width: 320px;
          background: white;
          box-shadow: 0 0 20px rgba(0,0,0,0.15);
          border-radius: 8px;
          z-index: 9999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
          overflow: hidden;
        }
        
        .profile-info-header {
          background: #0a66c2;
          color: white;
          padding: 15px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .profile-info-title {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }
        
        .profile-info-close {
          background: none;
          border: none;
          color: white;
          font-size: 18px;
          cursor: pointer;
        }
        
        .profile-info-content {
          padding: 15px;
        }
        
        .profile-info-avatar {
          width: 60px;
          height: 60px;
          border-radius: 50%;
          background: #0a66c2;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 24px;
          font-weight: 600;
          margin-right: 15px;
        }
        
        .profile-info-basics {
          display: flex;
          margin-bottom: 15px;
        }
        
        .profile-info-name {
          font-size: 18px;
          font-weight: 600;
          margin-bottom: 5px;
        }
        
        .profile-info-position {
          font-size: 14px;
          color: #666;
          margin-bottom: 5px;
        }
        
        .profile-info-company {
          font-size: 14px;
          color: #0a66c2;
        }
        
        .profile-info-details {
          margin-top: 15px;
          border-top: 1px solid #eee;
          padding-top: 15px;
        }
        
        .profile-info-detail {
          display: flex;
          margin-bottom: 10px;
        }
        
        .profile-info-label {
          width: 80px;
          color: #666;
          font-size: 13px;
        }
        
        .profile-info-value {
          flex: 1;
          font-size: 13px;
        }
        
        .profile-info-actions {
          display: flex;
          gap: 10px;
          margin-top: 15px;
        }
        
        .profile-info-btn {
          flex: 1;
          padding: 8px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-size: 13px;
          text-align: center;
        }
        
        .profile-info-btn.primary {
          background: #0a66c2;
          color: white;
        }
        
        .profile-info-btn.secondary {
          background: #f5f5f5;
          color: #666;
        }
        
        .email-suggestions {
          margin-top: 15px;
          background: #f5f8fa;
          padding: 12px;
          border-radius: 6px;
        }
        
        .email-suggestions-title {
          font-size: 14px;
          font-weight: 600;
          margin-bottom: 8px;
          color: #333;
          display: flex;
          align-items: center;
        }
        
        .suggested-email {
          background: white;
          border: 1px solid #e0e0e0;
          padding: 6px 10px;
          border-radius: 4px;
          margin-bottom: 6px;
          font-size: 13px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .suggested-email:last-child {
          margin-bottom: 0;
        }
        
        .email-format {
          color: #888;
          font-size: 11px;
          margin-left: 5px;
        }
        
        .copy-email {
          border: none;
          background: none;
          color: #0a66c2;
          cursor: pointer;
          font-size: 12px;
          padding: 4px;
        }
        
        .copy-email:hover {
          background: rgba(10, 102, 194, 0.1);
          border-radius: 3px;
        }
        
        .domain-info {
          font-size: 12px;
          color: #666;
          margin-top: 6px;
          font-style: italic;
        }
      `
    });
    
    // Create and inject the profile info panel
    await page.evaluate((details) => {
      // Remove any existing panel
      const existingPanel = document.querySelector('.profile-info-panel');
      if (existingPanel) {
        existingPanel.remove();
      }
      
      // Create the panel
      const panel = document.createElement('div');
      panel.className = 'profile-info-panel';
      
      // Get initials for avatar
      const initials = 
        (details.firstName ? details.firstName.charAt(0).toUpperCase() : '') + 
        (details.lastName ? details.lastName.charAt(0).toUpperCase() : '');
      
      // Prepare email suggestions HTML
      let emailSuggestionsHTML = '';
      if (details.suggestedEmails && details.suggestedEmails.length > 0) {
        const formatPatterns = ['first.last', 'firstlast', 'first_last', 'f.last', 'flast', 'firstl', 'first', 'last'];
        
        emailSuggestionsHTML = `
          <div class="email-suggestions">
            <div class="email-suggestions-title">
              Possible Email Formats
            </div>
            ${details.suggestedEmails.map((email, index) => {
              const formatName = formatPatterns[index] || 'custom';
              return `
                <div class="suggested-email">
                  <div>
                    ${email}
                    <span class="email-format">(${formatName})</span>
                  </div>
                  <button class="copy-email" data-email="${email}">Copy</button>
                </div>
              `;
            }).join('')}
            ${details.companyDomain ? `<div class="domain-info">Inferred domain: ${details.companyDomain}</div>` : ''}
          </div>
        `;
      }
      
      panel.innerHTML = `
        <div class="profile-info-header">
          <h3 class="profile-info-title">Profile Information</h3>
          <button class="profile-info-close">&times;</button>
        </div>
        <div class="profile-info-content">
          <div class="profile-info-basics">
            <div class="profile-info-avatar">${initials}</div>
            <div>
              <div class="profile-info-name">${details.firstName} ${details.lastName}</div>
              <div class="profile-info-position">${details.position || details.title || ''}</div>
              <div class="profile-info-company">${details.company}</div>
            </div>
          </div>
          
          <div class="profile-info-details">
            <div class="profile-info-detail">
              <div class="profile-info-label">Email:</div>
              <div class="profile-info-value">${details.email}</div>
            </div>
            
            ${details.location ? `
            <div class="profile-info-detail">
              <div class="profile-info-label">Location:</div>
              <div class="profile-info-value">${details.location}</div>
            </div>
            ` : ''}
            
            <div class="profile-info-detail">
              <div class="profile-info-label">LinkedIn:</div>
              <div class="profile-info-value">
                <a href="${details.profileUrl}" target="_blank">View Profile</a>
              </div>
            </div>
          </div>
          
          ${emailSuggestionsHTML}
          
          <div class="profile-info-actions">
            <button class="profile-info-btn primary" id="connect-profile-btn">Connect</button>
            <button class="profile-info-btn secondary" id="add-to-workflow-btn">Add to Workflow</button>
          </div>
        </div>
      `;
      
      // Add to the document
      document.body.appendChild(panel);
      
      // Add event listeners
      document.querySelector('.profile-info-close').addEventListener('click', () => {
        panel.remove();
      });
      
      // Connect button
      document.getElementById('connect-profile-btn').addEventListener('click', () => {
        console.log('Connect requested with:', details);
      });
      
      // Add to workflow button
      document.getElementById('add-to-workflow-btn').addEventListener('click', () => {
        console.log('Add to workflow requested:', details);
      });
      
      // Copy email buttons
      const copyButtons = document.querySelectorAll('.copy-email');
      copyButtons.forEach(button => {
        button.addEventListener('click', function() {
          const email = this.getAttribute('data-email');
          navigator.clipboard.writeText(email)
            .then(() => {
              const originalText = this.textContent;
              this.textContent = 'Copied!';
              setTimeout(() => {
                this.textContent = originalText;
              }, 2000);
            })
            .catch(err => {
              console.error('Failed to copy email: ', err);
            });
        });
      });
      
      return true;
    }, profileDetails);
    
    logAction('Profile information panel displayed');
    return true;
  } catch (error) {
    logError('Error displaying profile information', error);
    return false;
  }
}

module.exports = {
  displayProfileInformation
};