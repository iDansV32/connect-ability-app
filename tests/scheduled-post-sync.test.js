const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canSchedulePostOnLinkedIn,
  hasLinkedInRemoteSchedule,
  syncScheduledPostsForAccount
} = require('../scheduled-post-sync');

test('scheduled post sync detects LinkedIn-native scheduling candidates', () => {
  assert.equal(canSchedulePostOnLinkedIn({
    content: 'Text post',
    scheduledDate: '2026-03-24',
    scheduledTime: '09:00',
    postType: 'text'
  }), true);
  assert.equal(canSchedulePostOnLinkedIn({
    content: 'Image post',
    scheduledDate: '2026-03-24',
    scheduledTime: '09:00',
    postType: 'image',
    includeImage: true
  }), false);
});

test('scheduled post sync preserves unchanged LinkedIn-native posts and falls back when scheduling fails', async () => {
  const syncResult = await syncScheduledPostsForAccount({
    existingPosts: [{
      id: 'post-existing',
      content: 'Keep this',
      scheduledDate: '2026-03-24',
      scheduledTime: '09:00',
      status: 'scheduled',
      linkedInResourceKey: 'urn:li:share:123',
      linkedInScheduledAt: '1774342800000'
    }],
    desiredPosts: [
      {
        id: 'post-existing',
        content: 'Keep this',
        scheduledDate: '2026-03-24',
        scheduledTime: '09:00',
        postType: 'text'
      },
      {
        id: 'post-new',
        content: 'Schedule this',
        scheduledDate: '2026-03-25',
        scheduledTime: '09:00',
        postType: 'text'
      }
    ],
    createLinkedInSession: async () => ({
      async schedulePost(post) {
        if (post.id === 'post-new') {
          throw new Error('Composer unavailable');
        }
        return { resourceKey: 'urn:li:share:999', scheduledAt: '1774429200000' };
      },
      async deletePost() {
        return true;
      },
      async close() {}
    })
  });

  assert.equal(syncResult.posts.length, 2);
  assert.equal(syncResult.posts[0].status, 'scheduled');
  assert.equal(syncResult.posts[0].linkedInResourceKey, 'urn:li:share:123');
  assert.equal(syncResult.posts[1].status, 'pending');
  assert.equal(syncResult.posts[1].deliveryStrategy, 'local_queue');
  assert.equal(syncResult.summary.preservedRemoteCount, 1);
  assert.equal(syncResult.summary.fallbackLocalCount, 1);
  assert.equal(syncResult.summary.remoteScheduledCount, 0);
});

test('scheduled post sync deletes removed LinkedIn-native posts and schedules new ones', async () => {
  const deleted = [];
  const scheduled = [];

  const syncResult = await syncScheduledPostsForAccount({
    existingPosts: [{
      id: 'post-old',
      content: 'Old',
      scheduledDate: '2026-03-24',
      scheduledTime: '09:00',
      status: 'scheduled',
      linkedInResourceKey: 'urn:li:share:old'
    }],
    desiredPosts: [{
      id: 'post-new',
      content: 'New',
      scheduledDate: '2026-03-26',
      scheduledTime: '09:00',
      postType: 'text'
    }],
    createLinkedInSession: async () => ({
      async schedulePost(post) {
        scheduled.push(post.id);
        return { resourceKey: 'urn:li:share:new', scheduledAt: '1774515600000' };
      },
      async deletePost(resourceKey) {
        deleted.push(resourceKey);
        return true;
      },
      async close() {}
    })
  });

  assert.deepEqual(deleted, ['urn:li:share:old']);
  assert.deepEqual(scheduled, ['post-new']);
  assert.equal(syncResult.posts[0].status, 'scheduled');
  assert.equal(syncResult.posts[0].linkedInResourceKey, 'urn:li:share:new');
  assert.equal(hasLinkedInRemoteSchedule(syncResult.posts[0]), true);
  assert.equal(syncResult.summary.remoteDeletedCount, 1);
  assert.equal(syncResult.summary.remoteScheduledCount, 1);
});
