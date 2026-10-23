package io.harnessy.companion.nativeapp

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map

private val Context.nativePreferences by preferencesDataStore(name = "native_preferences")

enum class ThemePreference { SYSTEM, LIGHT, DARK }
data class ThemeSettings(
    val theme: ThemePreference = ThemePreference.SYSTEM,
    val readFailed: Boolean = false,
    val workspaceExpansion: WorkspaceExpansion = WorkspaceExpansion(),
)

/** Ordinary appearance preferences only. PairingStore/OperationStore/AndroidKeyStore remain authoritative. */
@Singleton
class NativePreferences internal constructor(private val store: DataStore<Preferences>) {
    @Inject constructor(@ApplicationContext context: Context) : this(context.nativePreferences)

    private val themeKey = stringPreferencesKey("theme")
    private val expandedWorkspacesKey = stringSetPreferencesKey("expanded_workspaces_v1")

    val settings: Flow<ThemeSettings> = store.data.map { preferences ->
        val rawTheme = preferences[themeKey]
        val theme = ThemePreference.entries.firstOrNull { it.name == rawTheme }
        ThemeSettings(
            theme = theme ?: ThemePreference.SYSTEM,
            readFailed = rawTheme != null && theme == null,
            workspaceExpansion = WorkspaceExpansion(preferences[expandedWorkspacesKey].orEmpty()),
        )
    }.catch { failure ->
        if (failure is IOException) emit(ThemeSettings(readFailed = true)) else throw failure
    }

    /** Returns only after DataStore commits; callers show failure instead of an optimistic saved state. */
    suspend fun setTheme(theme: ThemePreference) {
        store.edit { preferences -> preferences[themeKey] = theme.name }
    }

    /** Commits one explicit folder choice without replacing theme or other folders' choices. */
    suspend fun setWorkspaceExpansion(choice: WorkspaceExpansionChoice) {
        store.edit { preferences ->
            preferences[expandedWorkspacesKey] = WorkspaceExpansion(preferences[expandedWorkspacesKey].orEmpty())
                .updated(choice).expandedKeys
        }
    }
}
