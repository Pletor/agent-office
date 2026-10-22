// ==UserScript==
// @name         generals.io — hide ad containers
// @namespace    https://github.com/Pletor/agent-office
// @version      1.0.0
// @description  Hide generals.io advertising slots, including inside the Boss PC iframe. Cosmetic only.
// @match        https://generals.io/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (location.origin !== 'https://generals.io') return;
  const id = 'office-generals-hide-ads';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  // Verified against generals.io v31.4.4. No broad [class*="ad"] matches:
  // those would also hide leaderboard/header controls. CSS covers new React nodes.
  style.textContent = `
    #replay-ad-container,
    #custom-queue-ad-top,
    #custom-queue-ad,
    #custom-queue-ad-skyscraper,
    #custom-queue-ad-skyscraper-2,
    #custom-queue-bottom-ad,
    [id^="div-gpt-ad-"] {
      display: none !important;
    }
    #custom-queue-content { padding-left: 0 !important; padding-right: 0 !important; }
  `;
  document.head.append(style);
})();
