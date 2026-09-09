export function timestamp(value: string | null): number {
  // Require explicit UTC/offset; never infer a timezone or use retrieval as market time.
  return value && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    ? Date.parse(value) : NaN;
}
