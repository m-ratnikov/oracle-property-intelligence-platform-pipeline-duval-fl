/**
 * The registered tools, in the order the model sees them.
 *
 * This lives in its own leaf module, with no imports, because three surfaces publish this list as a
 * claim about what the agent can read: the agent loop registers it, GET /api/agent reports it, and
 * the /agent page prints it. Two of those had drifted to a stale five-name copy after count_criteria
 * was added, so the page understated the tool set while the docs described six. The page is a client
 * component, so it cannot import the loop itself without pulling the model SDK into the browser
 * bundle, which is why the shared constant is here rather than in run.ts.
 *
 * count_criteria is last rather than beside run_sql: the cached prompt prefix is keyed on this
 * order, and inserting into the middle would invalidate the cache on every request.
 */
export const TOOL_ORDER = [
  "get_schema",
  "preset_question",
  "run_sql",
  "get_property",
  "get_run_history",
  "count_criteria",
] as const;
