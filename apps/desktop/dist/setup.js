// Setup page: asks for the server address. Rust re-validates everything
// (check_server, save_server); the checks here only shape the messages.
(function () {
  'use strict';

  var form = document.getElementById('setup');
  var input = document.getElementById('server-url');
  var button = document.getElementById('connect');
  var error = document.getElementById('error');
  var notice = document.getElementById('insecure');
  var status = document.getElementById('status');
  var busy = false;
  // An http address must be confirmed with a second Connect after the notice.
  var confirmedInsecure = null;

  // Same channel as the web app's bridge (@tauri-apps/api uses it too);
  // the global Tauri API is not enabled.
  function invoke(cmd, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function') {
      return Promise.reject('Open this page in the Backroom app.');
    }
    return internals.invoke(cmd, args);
  }

  function text(e) {
    return typeof e === 'string' && e ? e : 'Something went wrong. Try again.';
  }

  function setBusy(on, message) {
    busy = on;
    button.disabled = on;
    input.readOnly = on;
    status.textContent = message || '';
  }

  function showError(message) {
    error.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  function clearError() {
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  }

  function resetInsecure() {
    confirmedInsecure = null;
    notice.hidden = true;
    button.textContent = 'Connect';
  }

  input.addEventListener('input', function () {
    clearError();
    resetInsecure();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    clearError();
    var url = input.value.trim();
    if (!url) {
      showError("Enter your server's address.");
      return;
    }
    setBusy(true, 'Checking the server…');
    invoke('check_server', { url: url })
      .then(function (result) {
        if (result.insecure && confirmedInsecure !== result.origin) {
          confirmedInsecure = result.origin;
          notice.hidden = false;
          button.textContent = 'Connect anyway';
          setBusy(false);
          button.focus();
          return;
        }
        setBusy(true, 'Connecting to ' + result.origin + '…');
        return invoke('save_server', { url: url });
      })
      .catch(function (e) {
        setBusy(false);
        showError(text(e));
      });
  });

  input.focus();
})();
