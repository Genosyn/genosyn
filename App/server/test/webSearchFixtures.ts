/**
 * Public DuckDuckGo HTML fixtures. The challenge is reduced from an HTTP 202
 * response captured on 2026-09-29 with GenosynWebBot. Its request identifiers,
 * image hashes, challenge inputs and URLs were removed; no browser state was used.
 */
export const SEARCH_CHALLENGE_PAGE = `
<html><body>
  <form id="challenge-form" action="//duckduckgo.com/anomaly.js" method="POST">
    <div class="anomaly-modal__mask">
      <div class="anomaly-modal__modal is-ie" data-testid="anomaly-modal">
        <div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
        <div class="anomaly-modal__description">Please complete the following challenge to confirm this search was made by a human.</div>
      </div>
    </div>
  </form>
</body></html>`;

/** Explicit empty-results markup, without a query or a visitor identifier. */
export const EMPTY_SEARCH_PAGE = `
<html><body><div class="results">
  <div class="no-results__message"><h1>No results found for this query</h1></div>
</div></body></html>`;
