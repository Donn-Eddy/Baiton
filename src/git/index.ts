/**
 * Git service seam (design "Git service"). All git operations run through this
 * single seam so the journal and recovery see one place for reads, writes and
 * resets.
 */
export * from './types';
export * from './gitService';
