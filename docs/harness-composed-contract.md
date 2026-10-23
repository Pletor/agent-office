# Harness composition contract

`tests/harness-night-integration.test.ts` reuses the existing isolated composition proof. It checks hierarchy inheritance, authenticated worker CLI reads, administrator-only writes, scope drift, stale saves, and recommendation behavior against a Canvas without optional verifier endpoints. Missing verifier history and capacity must stay unavailable; they cannot become promotion permission.

Run `node --import tsx --import=#tests/css --test tests/harness-night-integration.test.ts` from the Office checkout. The test uses disposable local HTTP servers and temporary storage, with no live settings, paid agents or production acceptance. It runs fully when the hierarchy, recommendation, runner-probe, paired-history and native-verifier modules are present. Otherwise it reports an explicit skip naming missing modules. A skip is not composition evidence; release validation must run on the composed feature tree.

The prior integration-only fake Canvas asserted that every non-learning request was `/api/view`, so newly installed optional peer readers caused an uncaught assertion instead of an HTTP unavailable response. The fixture now handles those two documented optional endpoints explicitly, verifies both were queried, and checks that their unavailable status reaches the worker. Unexpected paths still fail the test.

This test does not prove actual tool invocation, independent fixture execution, OpenViking delivery, automatic promotion/rollback or deployment. Those remain separate acceptance checks in the Harness goal. This PR adds no runtime feature and does not duplicate the existing feature branches.
