const LINKEDIN_REMOTE_DELIVERY = 'linkedin_scheduled';
const LOCAL_QUEUE_DELIVERY = 'local_queue';

function cleanString(value, maxLength = 1024) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function hasLinkedInRemoteSchedule(post = {}) {
  return Boolean(cleanString(post.linkedInResourceKey, 240));
}

function canSchedulePostOnLinkedIn(post = {}) {
  const normalizedStatus = cleanString(post.status, 40).toLowerCase();
  if (normalizedStatus === 'published' || normalizedStatus === 'cancelled') {
    return false;
  }
  if (!cleanString(post.scheduledDate, 32) || !cleanString(post.scheduledTime, 32)) {
    return false;
  }
  if (Boolean(post.includeImage) || cleanString(post.imagePath, 1200)) {
    return false;
  }
  const postType = cleanString(post.postType, 40).toLowerCase() || 'text';
  return postType === 'text';
}

function normalizeSyncSignature(post = {}) {
  return JSON.stringify([
    cleanString(post.content, 3200),
    cleanString(post.scheduledDate, 32),
    cleanString(post.scheduledTime, 32),
    cleanString(post.visibility, 40).toLowerCase() || 'public',
    cleanString(post.postType, 40).toLowerCase() || 'text',
    Boolean(post.includeImage),
    cleanString(post.imagePath, 1200),
    cleanString(post.accountId, 160),
    cleanString(post.agentId, 160)
  ]);
}

function normalizeFallbackStatus(post = {}) {
  const normalizedStatus = cleanString(post.status, 40).toLowerCase();
  if (normalizedStatus === 'failed' || normalizedStatus === 'cancelled' || normalizedStatus === 'published') {
    return normalizedStatus;
  }
  return 'pending';
}

function clearLinkedInRemoteFields(post = {}) {
  return {
    ...post,
    deliveryStrategy: post.deliveryStrategy === LINKEDIN_REMOTE_DELIVERY
      ? LOCAL_QUEUE_DELIVERY
      : cleanString(post.deliveryStrategy, 80) || LOCAL_QUEUE_DELIVERY,
    linkedInResourceKey: null,
    linkedInScheduledAt: null,
    linkedInLastSyncedAt: null,
    linkedInSyncError: null
  };
}

function preserveLinkedInRemoteFields(post = {}, existingPost = {}) {
  return {
    ...post,
    status: 'scheduled',
    deliveryStrategy: LINKEDIN_REMOTE_DELIVERY,
    linkedInResourceKey: cleanString(existingPost.linkedInResourceKey, 240) || null,
    linkedInScheduledAt: cleanString(existingPost.linkedInScheduledAt, 80) || null,
    linkedInLastSyncedAt: cleanString(existingPost.linkedInLastSyncedAt, 80) || null,
    linkedInSyncError: null,
    error: null,
    publishedAt: null
  };
}

function buildExistingRemotePostLookup(existingPosts = []) {
  const byId = new Map();
  const bySignature = new Map();

  existingPosts.forEach((post) => {
    const id = cleanString(post.id, 160);
    if (id) {
      byId.set(id, post);
    }
    if (hasLinkedInRemoteSchedule(post)) {
      const signature = normalizeSyncSignature(post);
      if (!bySignature.has(signature)) {
        bySignature.set(signature, post);
      }
    }
  });

  return { byId, bySignature };
}

function collectRemotePostsToDelete(existingPosts = [], keptRemotePosts = new Set()) {
  return existingPosts.filter((post) => {
    if (!hasLinkedInRemoteSchedule(post)) {
      return false;
    }
    const resourceKey = cleanString(post.linkedInResourceKey, 240);
    if (!resourceKey) {
      return false;
    }
    return !keptRemotePosts.has(resourceKey);
  });
}

async function syncScheduledPostsForAccount(options = {}) {
  const desiredPosts = Array.isArray(options.desiredPosts) ? options.desiredPosts : [];
  const existingPosts = Array.isArray(options.existingPosts) ? options.existingPosts : [];
  const emitLog = typeof options.emitLog === 'function' ? options.emitLog : () => {};
  const createLinkedInSession = typeof options.createLinkedInSession === 'function'
    ? options.createLinkedInSession
    : null;

  const lookup = buildExistingRemotePostLookup(existingPosts);
  const keptRemoteResourceKeys = new Set();
  const operations = desiredPosts.map((rawPost) => {
    const post = rawPost && typeof rawPost === 'object' ? { ...rawPost } : {};
    const postId = cleanString(post.id, 160);
    let existingPost = postId ? lookup.byId.get(postId) || null : null;
    if (!existingPost && hasLinkedInRemoteSchedule(post)) {
      existingPost = post;
    }
    if (!existingPost) {
      existingPost = lookup.bySignature.get(normalizeSyncSignature(post)) || null;
    }

    if (existingPost && hasLinkedInRemoteSchedule(existingPost)
      && normalizeSyncSignature(existingPost) === normalizeSyncSignature(post)) {
      const resourceKey = cleanString(existingPost.linkedInResourceKey, 240);
      if (resourceKey) {
        keptRemoteResourceKeys.add(resourceKey);
      }
      return {
        type: 'preserve',
        post,
        existingPost
      };
    }

    return {
      type: canSchedulePostOnLinkedIn(post) ? 'schedule' : 'fallback',
      post,
      existingPost
    };
  });

  const postsToDelete = collectRemotePostsToDelete(existingPosts, keptRemoteResourceKeys);
  const summary = {
    preservedRemoteCount: operations.filter((entry) => entry.type === 'preserve').length,
    remoteScheduledCount: 0,
    remoteDeletedCount: 0,
    fallbackLocalCount: 0,
    warnings: []
  };

  let session = null;
  const needsLinkedInSession = Boolean(createLinkedInSession)
    && (postsToDelete.length > 0 || operations.some((entry) => entry.type === 'schedule'));
  if (needsLinkedInSession) {
    session = await createLinkedInSession();
  }

  try {
    for (const post of postsToDelete) {
      const resourceKey = cleanString(post.linkedInResourceKey, 240);
      if (!resourceKey || !session || typeof session.deletePost !== 'function') {
        continue;
      }
      try {
        await session.deletePost(resourceKey);
        summary.remoteDeletedCount += 1;
      } catch (error) {
        summary.warnings.push(`Could not remove LinkedIn scheduled post ${resourceKey}: ${error.message || String(error)}`);
        emitLog({
          message: `Could not remove LinkedIn scheduled post ${resourceKey}: ${error.message || String(error)}`,
          type: 'warning'
        });
      }
    }

    const nextPosts = [];
    for (const entry of operations) {
      if (entry.type === 'preserve') {
        nextPosts.push(preserveLinkedInRemoteFields(entry.post, entry.existingPost));
        continue;
      }

      let fallbackWarning = null;
      if (entry.type === 'schedule' && session && typeof session.schedulePost === 'function') {
        try {
          const scheduledResult = await session.schedulePost(entry.post);
          nextPosts.push({
            ...clearLinkedInRemoteFields(entry.post),
            status: 'scheduled',
            deliveryStrategy: LINKEDIN_REMOTE_DELIVERY,
            linkedInResourceKey: cleanString(scheduledResult?.resourceKey, 240) || null,
            linkedInScheduledAt: cleanString(scheduledResult?.scheduledAt, 80) || null,
            linkedInLastSyncedAt: new Date().toISOString(),
            linkedInSyncError: null,
            publishedAt: null,
            error: null
          });
          summary.remoteScheduledCount += 1;
          continue;
        } catch (error) {
          fallbackWarning = `LinkedIn-native scheduling failed for "${cleanString(entry.post.content, 80)}": ${error.message || String(error)}`;
          summary.warnings.push(fallbackWarning);
          emitLog({ message: fallbackWarning, type: 'warning' });
        }
      } else if (entry.type === 'schedule') {
        fallbackWarning = `LinkedIn-native scheduling skipped for "${cleanString(entry.post.content, 80)}" because no authenticated LinkedIn session was available.`;
        summary.warnings.push(fallbackWarning);
        emitLog({ message: fallbackWarning, type: 'warning' });
      }

      nextPosts.push({
        ...clearLinkedInRemoteFields(entry.post),
        status: normalizeFallbackStatus(entry.post),
        linkedInSyncError: entry.type === 'schedule' ? fallbackWarning : null
      });
      summary.fallbackLocalCount += 1;
    }

    return {
      posts: nextPosts,
      summary
    };
  } finally {
    await session?.close?.();
  }
}

module.exports = {
  LINKEDIN_REMOTE_DELIVERY,
  LOCAL_QUEUE_DELIVERY,
  canSchedulePostOnLinkedIn,
  hasLinkedInRemoteSchedule,
  normalizeSyncSignature,
  syncScheduledPostsForAccount
};
