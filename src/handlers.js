// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so
// the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle ------------------------------------------
  // The known server, never a reading (the next one comes at its time).
  gladys.onScanRequest(() => app.publishDiscovery());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  // Updated: the SDK forgot its states, and Gladys may have reset its badge.
  gladys.onDeviceUpdated((device) => app.deviceUpdated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // --- Commands: the action buttons only (each refused unless allowed) ---------
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // --- Configuration screen buttons --------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.TRUST_CERTIFICATE, () => app.trustCertificate());

  // --- Configuration saved by the user: the password saved is tried (after the
  // login gate).
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config, { force: true });
  });

  // --- Connection lifecycle: every connection reads the configuration and
  // sends the status and Discovery again; the same configuration keeps the
  // session, the pace and the failures. A configuration Gladys does not give
  // is asked again without end (30 s, 1 min... 10 min at most).
  gladys.on('connected', () =>
    app.startFromGladys().catch((err) => logger?.error(`Start failed (${err?.name ?? 'Error'})`)),
  );
  gladys.on('disconnected', () => app.pause());
}
