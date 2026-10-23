package io.harnessy.companion.nativeapp

import io.harnessy.companion.presentation.DisplayModels.SessionRow
import io.harnessy.companion.presentation.DisplayModels.SessionStatus
import io.harnessy.companion.presentation.DisplayModels.WorkspaceInfo

internal data class NavigationFilter(val query: String, val openOnly: Boolean)
internal data class WorkspaceGroup(val workspace: WorkspaceInfo?, val sessions: List<SessionRow>)

/** Groups only PC-declared membership; matching names never merge distinct Workspace identities. */
internal fun navigationGroups(rows: List<SessionRow>, filter: NavigationFilter): List<WorkspaceGroup> {
    val query = filter.query.trim()
    val matching = rows.filter { row ->
        (!filter.openOnly || row.status != SessionStatus.CLOSED) &&
            (row.title.contains(query, ignoreCase = true) || row.navigation?.workspace?.title?.contains(query, ignoreCase = true) == true)
    }
    val grouped = matching.groupBy { it.navigation?.workspace?.id }
    return grouped.values.map { members ->
        WorkspaceGroup(members.first().navigation?.workspace, members.sortedWith(navigationOrder))
    }.sortedWith(compareBy<WorkspaceGroup> { it.workspace == null }
        .thenBy { it.workspace?.order ?: Long.MAX_VALUE }.thenBy { it.workspace?.id.orEmpty() })
}

private val navigationOrder = compareBy<SessionRow> { it.navigation?.pinOrder == null }
    .thenBy { it.navigation?.pinOrder ?: Long.MAX_VALUE }
    .thenByDescending { it.navigation?.updatedAt ?: 0L }

internal enum class SessionAgeUnit { NOW, MINUTES, HOURS, DAYS, MONTHS, YEARS }
internal data class SessionAge(val unit: SessionAgeUnit, val count: Long)

/** Matches Desktop's compact relative-time buckets, including future-clock clamping. */
internal fun sessionAge(updatedAt: Long, now: Long): SessionAge {
    val age = (now - updatedAt).coerceAtLeast(0L)
    return when {
        age < 60_000L -> SessionAge(SessionAgeUnit.NOW, 0L)
        age < 3_600_000L -> SessionAge(SessionAgeUnit.MINUTES, age / 60_000L)
        age < 86_400_000L -> SessionAge(SessionAgeUnit.HOURS, age / 3_600_000L)
        age < 30L * 86_400_000L -> SessionAge(SessionAgeUnit.DAYS, age / 86_400_000L)
        age < 365L * 86_400_000L -> SessionAge(SessionAgeUnit.MONTHS, age / (30L * 86_400_000L))
        else -> SessionAge(SessionAgeUnit.YEARS, age / (365L * 86_400_000L))
    }
}
