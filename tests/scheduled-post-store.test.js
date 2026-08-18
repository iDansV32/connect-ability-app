const test = require('node:test');
const assert = require('node:assert/strict');

const ScheduledPostStore = require('../scheduled-post-store');
const { createTempWorkspace, writeJson } = require('./test-helpers');

test('ScheduledPostStore persists normalized scheduled posts', () => {
  const workspace = createTempWorkspace('scheduled-post-store-');
  try {
    const store = new ScheduledPostStore({
      storePath: workspace.path('scheduled-posts.json')
    });

    const savedPosts = store.replaceAllPosts([
      {
        id: 'post-2',
        content: 'Second scheduled post',
        scheduledDate: '2026-03-23',
        scheduledTime: '09:30',
        status: 'scheduled',
        deliveryStrategy: 'linkedin_scheduled',
        linkedInResourceKey: 'urn:li:share:post-2',
        linkedInScheduledAt: '1774258200000',
        hashtags: ['#CustomerSuccess', '#customersuccess'],
        agentId: 'agent-1',
        agentName: 'Customer Success SDR',
        sourceType: 'agent_plan',
        planId: 'plan-1',
        planName: 'Customer Success SDR 90-day content plan',
        contentPillar: 'Retention',
        contentAngle: 'insight',
        contentTheme: 'Retention • Chief of Staff',
        contentBrief: 'Insight post about retention.',
        contentDay: 1
      },
      {
        id: 'post-1',
        content: 'Immediate post',
        status: 'published',
        createdAt: '2026-03-21T10:00:00.000Z'
      }
    ]);

    assert.equal(savedPosts.length, 2);
    assert.deepEqual(savedPosts[0].hashtags, ['#CustomerSuccess']);
    assert.equal(savedPosts[0].status, 'scheduled');
    assert.equal(savedPosts[0].linkedInResourceKey, 'urn:li:share:post-2');
    assert.equal(savedPosts[0].agentId, 'agent-1');
    assert.equal(savedPosts[0].planId, 'plan-1');
    assert.equal(savedPosts[1].agentId, null);

    const loadedPosts = store.getAllPosts();
    assert.equal(loadedPosts.length, 2);
    assert.equal(loadedPosts[0].id, 'post-1');
    assert.equal(loadedPosts[1].id, 'post-2');
    assert.equal(loadedPosts[1].contentTheme, 'Retention • Chief of Staff');
  } finally {
    workspace.cleanup();
  }
});

test('ScheduledPostStore rejects invalid post payloads', () => {
  const workspace = createTempWorkspace('scheduled-post-store-error-');
  try {
    const store = new ScheduledPostStore({
      storePath: workspace.path('scheduled-posts.json')
    });

    assert.throws(
      () => store.replaceAllPosts([{ id: 'bad-post', scheduledDate: '2026-03-23' }]),
      /Scheduled post content is required/
    );
  } finally {
    workspace.cleanup();
  }
});

test('ScheduledPostStore reads legacy versioned payloads and normalizes optional fields', () => {
  const workspace = createTempWorkspace('scheduled-post-store-legacy-');
  try {
    const storePath = workspace.path('scheduled-posts.json');
    writeJson(storePath, {
      version: 0,
      posts: [
        {
          id: 'legacy-post',
          content: 'Legacy scheduled post',
          createdAt: '2026-03-21T10:00:00.000Z'
        }
      ]
    });

    const store = new ScheduledPostStore({ storePath });
    const loadedPosts = store.getAllPosts();

    assert.equal(loadedPosts.length, 1);
    assert.equal(loadedPosts[0].id, 'legacy-post');
    assert.equal(loadedPosts[0].status, 'pending');
    assert.equal(loadedPosts[0].postType, 'text');
    assert.equal(loadedPosts[0].visibility, 'public');
    assert.equal(loadedPosts[0].agentId, null);
  } finally {
    workspace.cleanup();
  }
});

test('ScheduledPostStore replaces posts for one account without deleting another account queue', () => {
  const workspace = createTempWorkspace('scheduled-post-store-account-scope-');
  try {
    const store = new ScheduledPostStore({
      storePath: workspace.path('scheduled-posts.json')
    });

    store.replaceAllPosts([
      {
        id: 'ivan-post',
        content: 'Ivan post',
        scheduledDate: '2026-03-25',
        scheduledTime: '09:00',
        accountId: 'account-ivan',
        accountName: 'Ivan Dans'
      },
      {
        id: 'robert-post',
        content: 'Robert post',
        scheduledDate: '2026-03-26',
        scheduledTime: '09:00',
        accountId: 'account-robert',
        accountName: 'Robert Henderson'
      }
    ]);

    store.replacePostsForAccount('account-ivan', [
      {
        id: 'ivan-post-2',
        content: 'Ivan replacement post',
        scheduledDate: '2026-03-27',
        scheduledTime: '09:00'
      }
    ], { accountName: 'Ivan Dans' });

    const ivanPosts = store.getAllPosts({ accountId: 'account-ivan' });
    const robertPosts = store.getAllPosts({ accountId: 'account-robert' });

    assert.deepEqual(ivanPosts.map((post) => post.id), ['ivan-post-2']);
    assert.deepEqual(robertPosts.map((post) => post.id), ['robert-post']);
    assert.equal(ivanPosts[0].accountName, 'Ivan Dans');
  } finally {
    workspace.cleanup();
  }
});
