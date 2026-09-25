.pragma library
// Display only. Never creates choices, navigation targets or eligibility.
function code(row) { return row.sessionCode ? "Pi " + row.sessionCode : "Session code unavailable" }
function sharedBlocker(rows) {
    for (var i = 0; i < rows.length; i++) {
        if (["project_context_unavailable", "goal_required"].indexOf(rows[i].adoptionReasonCode) >= 0)
            return { code: rows[i].adoptionReasonCode, text: rows[i].adoptionReason || "" }
    }
    return { code: null, text: "" }
}
function reason(row, common) {
    return common.code !== null && row.adoptionReasonCode === common.code ? "" : (row.adoptionReason || "")
}
function exception(row) {
    if (row.availability !== "available") return "Connection unavailable"
    if (row.lifecycle !== "running") return row.lifecycle
    if (row.health !== "healthy") return row.health
    return ""
}
function navigation(row) {
    var nav = row.terminalNavigation
    if (!nav) return "Terminal navigation unavailable"
    if (nav.state === "unknown") return "Focus unverified — it may have changed"
    if (nav.state === "unavailable") return "Terminal navigation unavailable"
    if (nav.state === "checking") return "Switching…"
    return ""
}
function scope(snapshot) {
    return snapshot ? JSON.stringify([snapshot.sessionId, snapshot.pluginGeneration,
        snapshot.runnerEpoch, snapshot.selectedProjectId, snapshot.selectedGoalId]) : ""
}
