export interface ApiVersion {
  /** Path segment after /api, e.g. 'v1'. */
  id: string;
  /** Announcement day, YYYY-MM-DD in America/Bogota. Required with `sunset`. */
  deprecatedAt?: string;
  /** First day the version stops answering, YYYY-MM-DD in America/Bogota. Absent: no retirement. */
  sunset?: string;
}

// A version is retired only if it carries a sunset date.
export const apiVersions: readonly ApiVersion[] = [{ id: 'v1' }];
