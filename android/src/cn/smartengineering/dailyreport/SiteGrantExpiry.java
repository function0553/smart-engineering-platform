package cn.smartengineering.dailyreport;

/** Convert the server's bounded grant lifetime to a conservative monotonic deadline. */
final class SiteGrantExpiry {
  static final long MAX_LIFETIME_MS = 300000L;
  private static final String UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private SiteGrantExpiry() {}

  static boolean isPackageRoute(String method, String route) {
    return "POST".equals(method) && route != null && route.matches(
      "/api/mobile/engineering/(?:projects/" + UUID + "/)?site-library/packages");
  }

  static boolean isGrantRoute(String method, String route) {
    return isPackageRoute(method, route) || "POST".equals(method) && route != null && route.matches(
      "/api/mobile/engineering/projects/" + UUID + "/site-records/" + UUID + "/(?:files|exports)/" + UUID + "/media-grants");
  }

  static long deadline(long serverExpiry, long responseDate, long requestStarted, long received) {
    if (serverExpiry <= 0 || responseDate <= 0 || requestStarted < 0 || received < requestStarted)
      throw new IllegalArgumentException("Invalid grant time");
    long lifetime = Math.subtractExact(serverExpiry, responseDate);
    // HTTP Date is rounded down to seconds. Deduct its full precision interval,
    // and the entire request duration, so the local gate never extends the grant.
    if (lifetime <= 0 || lifetime > MAX_LIFETIME_MS + 999L)
      throw new IllegalArgumentException("Grant lifetime out of bounds");
    long remaining = lifetime - 1000L - (received - requestStarted);
    if (remaining <= 0) throw new IllegalArgumentException("Grant expired in transit");
    return Math.addExact(received, Math.min(remaining, MAX_LIFETIME_MS));
  }
}
