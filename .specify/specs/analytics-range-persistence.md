# Analytics Range Persistence

**Status**: draft

**Problem**: The analytics time range selector currently resets to its default (`'7d'`) on every page load and internal navigation, leading to a poor user experience as the user constantly has to re-select their preferred range.

**Solution**: Implement a generic `usePersistedState` React hook, backed by `localStorage`, to store the user's selected time range. This hook will seamlessly replace the existing `useState` call in `AnalyticsPage.tsx`, ensuring that the selection persists across full page reloads and single-page application (SPA) navigation.

**Acceptance Criteria**:
1. Selecting a time range (e.g., '24h', '7d', '30d') in the analytics dashboard persists after a full page reload (e.g., Ctrl+R or browser refresh).
2. Selecting a time range persists after SPA navigation (e.g., clicking on 'Keys' in the navigation and then returning to 'Analytics').
3. On a user's first visit, or if no stored value is found, the time range defaults gracefully to `'7d'`.
4. If the stored `localStorage` value for the time range is corrupted (e.g., invalid JSON), the application falls back gracefully to the default `'7d'` without crashing or displaying errors.
5. No server-side code changes are required for this feature; the implementation is entirely client-side.

**Test Strategy**: Playwright E2E tests will be developed to cover all acceptance criteria, simulating real user interactions and browser behavior.

**Out of Scope**:
- Cross-tab synchronization using the `storage` event listener is not required.
- Migration of existing `localStorage` usages (e.g., theme toggle, authentication token) to the new `usePersistedState` hook is not part of this task.
- Extraction of the `TimeRange` type to a shared location; it will remain inline within `AnalyticsPage.tsx`.
