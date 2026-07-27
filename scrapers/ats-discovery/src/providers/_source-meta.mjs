export const CAREER_OPS_REPOSITORY = 'santifer/career-ops';
export const CAREER_OPS_LICENSE = 'MIT';

export function providerSourceMeta({ file, ref, changes = [] }) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new Error('provider source file is required');
  }
  if (typeof ref !== 'string' || ref.trim() === '') {
    throw new Error('provider source ref is required');
  }
  if (!Array.isArray(changes) || changes.some((item) => typeof item !== 'string')) {
    throw new Error('provider source changes must be an array of strings');
  }
  return Object.freeze({
    repository: CAREER_OPS_REPOSITORY,
    file: file.trim(),
    ref: ref.trim(),
    license: CAREER_OPS_LICENSE,
    changes: Object.freeze([...changes]),
  });
}
