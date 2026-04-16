'use strict';
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function generateRequestId() {
  return crypto.randomBytes(16).toString('hex');
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sanitizeText(value, maxLen = 255) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>"'`]/g, '').trim().slice(0, maxLen);
}

function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}

async function recordAuditLog({ actorType = 'system', action, entityType, entityId = null, metadata = {} }) {
  if (!action || !entityType) return;
  await supabase.from('audit_logs').insert([{
    actor_type: actorType,
    action,
    entity_type: entityType,
    entity_id: entityId,
    metadata,
    created_at: new Date().toISOString(),
  }]);
}

async function incrementRateLimit(identifier, type, windowMs, maxRequests) {
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs).toISOString();
  const windowEnd = new Date(new Date(windowStart).getTime() + windowMs).toISOString();

  const { data: existing, error: selectError } = await supabase
    .from('rate_limits')
    .select('id,request_count')
    .eq('identifier', identifier)
    .eq('type', type)
    .eq('window_start', windowStart)
    .limit(1)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

  if (!existing) {
    const { data, error: insertError } = await supabase
      .from('rate_limits')
      .insert([{ identifier, type, request_count: 1, window_start: windowStart, window_end: windowEnd, created_at: now.toISOString(), updated_at: now.toISOString() }])
      .select()
      .single();

    if (insertError && insertError.message && insertError.message.includes('duplicate key value violates unique constraint')) {
      return incrementRateLimit(identifier, type, windowMs, maxRequests);
    }

    if (insertError) {
      throw insertError;
    }

    return {
      allowed: true,
      count: 1,
      remaining: Math.max(0, maxRequests - 1),
      resetAt: windowEnd,
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from('rate_limits')
    .update({ request_count: existing.request_count + 1, updated_at: now.toISOString() })
    .eq('id', existing.id)
    .select()
    .single();

  if (updateError) {
    throw updateError;
  }

  const count = updated.request_count;
  return {
    allowed: count <= maxRequests,
    count,
    remaining: Math.max(0, maxRequests - count),
    resetAt: windowEnd,
  };
}

async function getProductCache(cacheKey) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('product_cache')
    .select('payload,expires_at')
    .eq('cache_key', cacheKey)
    .gte('expires_at', now)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }
  return data ? data.payload : null;
}

async function setProductCache(cacheKey, payload, ttlSeconds = 300) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const { error } = await supabase
    .from('product_cache')
    .upsert([
      {
        cache_key: cacheKey,
        payload,
        expires_at: expiresAt,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ], { onConflict: ['cache_key'] });

  if (error) {
    throw error;
  }
}

async function fetchIdempotencyKey(key) {
  const { data, error } = await supabase
    .from('idempotency_keys')
    .select('*')
    .eq('key', key)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
}

async function reserveIdempotencyKey(key, endpoint, requestHash, expiresInSeconds = 3600) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
  const existing = await fetchIdempotencyKey(key);
  if (existing) {
    return existing;
  }
  const { data, error } = await supabase
    .from('idempotency_keys')
    .insert([
      {
        key,
        endpoint,
        request_hash: requestHash,
        status: 'processing',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: expiresAt,
      },
    ])
    .select()
    .single();
  if (error) {
    throw error;
  }
  return data;
}

async function completeIdempotencyKey(key, response, status = 'completed') {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('idempotency_keys')
    .update({ response, status, updated_at: now })
    .eq('key', key);
  if (error) {
    throw error;
  }
}

async function enqueueJob(jobType, payload, options = {}) {
  const now = new Date().toISOString();
  const row = {
    job_type: jobType,
    payload,
    status: 'pending',
    attempts: 0,
    max_attempts: options.maxAttempts || 5,
    next_run_at: new Date(Date.now() + (options.delayMs || 0)).toISOString(),
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase.from('job_queue').insert([row]).select().single();
  if (error) {
    throw error;
  }
  return data;
}

async function claimNextJob() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('job_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('next_run_at', now)
    .order('next_run_at', { ascending: true })
    .limit(1);

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const job = data[0];
  const { data: claimed, error: claimError } = await supabase
    .from('job_queue')
    .update({ status: 'processing', attempts: job.attempts + 1, updated_at: now })
    .eq('id', job.id)
    .eq('status', 'pending')
    .select()
    .single();

  if (claimError) {
    throw claimError;
  }

  return claimed || null;
}

async function completeJob(jobId, extra = {}) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('job_queue')
    .update({ status: 'completed', last_error: null, updated_at: now, ...extra })
    .eq('id', jobId);
  if (error) {
    throw error;
  }
}

async function failJob(jobId, errorMessage, retryDelayMs = 60 * 1000) {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + retryDelayMs).toISOString();
  const { error } = await supabase
    .from('job_queue')
    .update({ status: 'pending', last_error: errorMessage, next_run_at: nextRunAt, updated_at: now.toISOString() })
    .eq('id', jobId);
  if (error) {
    throw error;
  }
}

module.exports = {
  supabase,
  generateRequestId,
  hashValue,
  sanitizeText,
  log,
  recordAuditLog,
  incrementRateLimit,
  getProductCache,
  setProductCache,
  fetchIdempotencyKey,
  reserveIdempotencyKey,
  completeIdempotencyKey,
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
};
