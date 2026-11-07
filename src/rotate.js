'use strict';
// Shared rotation helper for JSONL append-only stores.
// Keeps files bounded by archiving to <file>.1 when reaching size threshold.
// Atomic rename guarantees zero lost writes across rotation boundaries.
//
// Privacy line:
// samples store numbers and names, never prompts, transcripts or screens.

const fs = require('fs');
const path = require('path');
const crewfile = require('./crewfile');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_MAX_DAYS = 30;
const DEFAULT_ARCHIVE_SUFFIX = '.1';

function resolveRetentionDays(options = {}) {
  if (typeof options.maxDays === 'number' && Number.isFinite(options.maxDays) && options.maxDays > 0) {
    return options.maxDays;
  }
  let crewPath = options.crewPath;
  if (!crewPath && crewfile.findCrewFile) {
    crewPath = crewfile.findCrewFile(process.cwd());
  }
  if (crewPath && crewfile.loadCrew) {
    const crew = crewfile.loadCrew(crewPath);
    if (crew && typeof crew.rotationDays === 'number' && crew.rotationDays > 0) {
      return crew.rotationDays;
    }
  }
  return DEFAULT_MAX_DAYS;
}

function rotate(file, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const maxDays = resolveRetentionDays(options);
  const suffix = options.suffix || DEFAULT_ARCHIVE_SUFFIX;
  const now = options.now !== undefined ? options.now : Date.now();

  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }

  const retentionMs = maxDays * 24 * 60 * 60 * 1000;
  const ageExceeded = (now - st.mtimeMs) >= retentionMs;
  const sizeExceeded = st.size >= maxBytes;

  if (!options.force && !sizeExceeded && !ageExceeded) {
    return false;
  }
  const archive = file + suffix;
  try {
    // Atomic rename in POSIX replaces archive if it exists.
    // Active file handle writers will continue to write to the old inode,
    // and subsequent appends will open a new active file.
    fs.renameSync(file, archive);
    return true;
  } catch {
    return false;
  }
}

function maybeRotate(file, options = {}) {
  try {
    return rotate(file, options);
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DAYS,
  DEFAULT_ARCHIVE_SUFFIX,
  resolveRetentionDays,
  rotate,
  maybeRotate,
};
