package cn.smartengineering.dailyreport;

/** Explicit method/path allowlist for project APIs; server still authenticates every request. */
final class EngineeringRoutes {
  private static final String ROOT = "/api/mobile/engineering";
  private static final String PROJECT = ROOT + "/projects/[0-9a-fA-F-]{36}";
  private static final String UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  private static final String REVIEW_PROJECT = ROOT + "/projects/" + UUID;
  static boolean allows(String method, String route) {
    if ("GET".equals(method) && (route.equals(ROOT + "/site-library") || route.matches(REVIEW_PROJECT + "/site-library"))) return true;
    if ("POST".equals(method) && (route.equals(ROOT + "/site-library/packages") || route.matches(REVIEW_PROJECT + "/site-library/packages") || route.matches(REVIEW_PROJECT + "/wbs/project-scope"))) return true;
    if ("GET".equals(method) && (route.matches(REVIEW_PROJECT + "/site-records/templates")
        || route.matches(REVIEW_PROJECT + "/site-records/templates/" + UUID + "/history"))) return true;
    if ("POST".equals(method) && (route.matches(REVIEW_PROJECT + "/site-records/templates")
        || route.matches(REVIEW_PROJECT + "/site-records/templates/" + UUID + "/state"))) return true;
    if ("PUT".equals(method) && route.matches(REVIEW_PROJECT + "/site-records/templates/" + UUID)) return true;
    if ("GET".equals(method)) return route.matches(REVIEW_PROJECT + "/site-access") || route.matches(REVIEW_PROJECT + "/site-records/"+UUID+"/handlers") || route.equals(ROOT) || route.matches(PROJECT + "(?:/users|/document-candidates|/baselines|/boq|/task-values|/value-plans|/replacements|/progress|/progress/export|/export|/wbs|/cost-control|/subcontract-ledger)?")
        || route.matches(PROJECT + "/site-records/batches(?:/[0-9a-fA-F-]{36}(?:/check)?)?")
        || route.matches(PROJECT + "/site-records(?:/[0-9a-fA-F-]{36}(?:/photo-table|/uploads/[0-9a-fA-F-]{36}|/files/[0-9a-fA-F-]{36}/thumbnail|/(?:files|exports)/[0-9a-fA-F-]{36}/download)?)?")
        || route.matches(PROJECT + "/items/[0-9a-fA-F-]{36}/attachments(?:/[0-9a-fA-F-]{36}/download)?");
    if ("POST".equals(method)) return route.matches(REVIEW_PROJECT + "/site-records/"+UUID+"/(?:submit|review|handoff|reviewer)") || route.equals(ROOT + "/projects")
        || route.matches(PROJECT + "/(?:state|stock|documents|replacements|replacements/[0-9a-fA-F-]{36}/state|value-plans|value-plans/[0-9a-fA-F-]{36}/state|boq|boq/[0-9a-fA-F-]{36}/state|baselines|baselines/[0-9a-fA-F-]{36}/state|corrections|corrections/[0-9a-fA-F-]{36}/state|reversals|reversals/[0-9a-fA-F-]{36}/state|items/(?:tasks|issues|contracts|variations|measurements|purchases|materials|settlements|costs|crews)|items/[0-9a-fA-F-]{36}/state)")
        || route.matches(PROJECT + "/(?:subcontract-policies|subcontract-policies/[0-9a-fA-F-]{36}/state|settlements/[0-9a-fA-F-]{36}/retention-releases|retention-releases/[0-9a-fA-F-]{36}/(?:state|voids)|retention-voids/[0-9a-fA-F-]{36}/state)")
        || route.matches(PROJECT + "/progress(?:/[0-9a-fA-F-]{36}/state)?")
        || route.matches(PROJECT + "/(?:wbs|cost-plans|cost-plans/[0-9a-fA-F-]{36}/state|consumptions|consumptions/[0-9a-fA-F-]{36}/(?:state|voids)|consumption-voids/[0-9a-fA-F-]{36}/state)")
        || route.matches(PROJECT + "/purchases/[0-9a-fA-F-]{36}/(?:receipts|terminations|terminations/[0-9a-fA-F-]{36}/state|returns|returns/[0-9a-fA-F-]{36}/(?:state|dispatch)|credits|credits/[0-9a-fA-F-]{36}/state|refunds|refunds/[0-9a-fA-F-]{36}/state)")
        || route.matches(PROJECT + "/site-records/batches(?:/[0-9a-fA-F-]{36}/state)?")
        || route.matches(PROJECT + "/site-records(?:/[0-9a-fA-F-]{36}/(?:archive|withdraw|exports(?:/[0-9a-fA-F-]{36}/media-grants)?|uploads(?:/[0-9a-fA-F-]{36}/(?:chunks|complete|cancel))?|files/[0-9a-fA-F-]{36}/(?:remove|step|media-grants)))?")
        || route.matches(PROJECT + "/items/[0-9a-fA-F-]{36}/attachments(?:/[0-9a-fA-F-]{36}/remove)?");
    if ("PUT".equals(method)) return route.matches(REVIEW_PROJECT + "/site-access(?:/"+UUID+")?") || route.matches(PROJECT + "/site-records/batches/[0-9a-fA-F-]{36}") || route.matches(PROJECT + "(?:/members|/value-plans/[0-9a-fA-F-]{36}|/boq/[0-9a-fA-F-]{36}|/items/[0-9a-fA-F-]{36}|/wbs/[0-9a-fA-F-]{36}|/wbs/tasks/[0-9a-fA-F-]{36}|/cost-plans/[0-9a-fA-F-]{36}|/site-records/[0-9a-fA-F-]{36})?");
    return false;
  }
}
