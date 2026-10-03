/*
  proxmox.computer — component bundle.
  Classic script. Reads no external state, makes no network calls.
  Everything here is progressive enhancement: every component in this
  system is fully legible as plain HTML and CSS without it.
*/
(function () {
  "use strict";

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    var el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    try { document.execCommand("copy"); } catch { /* no-op */ }
    document.body.removeChild(el);
    return Promise.resolve();
  }

  // Wires every [data-pc-copy-target] button to copy the text content
  // of the element its value points at (by id), and flip data-copied
  // for two seconds so pc-cmdline__copy / pc-btn can show "copied".
  function mountCopyButtons(root) {
    var scope = root || document;
    var buttons = scope.querySelectorAll("[data-pc-copy-target]");
    for (var i = 0; i < buttons.length; i++) {
      (function (btn) {
        if (btn.__pcBound) return;
        btn.__pcBound = true;
        btn.addEventListener("click", function () {
          var targetId = btn.getAttribute("data-pc-copy-target");
          var target = targetId ? document.getElementById(targetId) : null;
          var text = target ? target.textContent : (btn.getAttribute("data-pc-copy-text") || "");
          copyText(text).then(function () {
            var prev = btn.textContent;
            btn.setAttribute("data-copied", "true");
            btn.textContent = "copied";
            window.setTimeout(function () {
              btn.removeAttribute("data-copied");
              btn.textContent = prev;
            }, 2000);
          });
        });
      })(buttons[i]);
    }
  }

  // Lets a Checklist item toggle between pending, done and failed on
  // click, cycling data-state and the matching pc-check--* class.
  // Purely visual state for a preview or a static walkthrough page;
  // a real app should drive pc-check--done / pc-check--failed itself.
  var CYCLE = ["pending", "done", "failed"];

  function mountChecklist(root) {
    var scope = root || document;
    var items = scope.querySelectorAll(".pc-check[data-pc-toggle]");
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        if (item.__pcBound) return;
        item.__pcBound = true;
        item.style.cursor = "pointer";
        item.addEventListener("click", function () {
          var state = item.getAttribute("data-state") || "pending";
          var next = CYCLE[(CYCLE.indexOf(state) + 1) % CYCLE.length];
          item.classList.remove("pc-check--done", "pc-check--failed");
          if (next !== "pending") item.classList.add("pc-check--" + next);
          item.setAttribute("data-state", next);
          var box = item.querySelector(".pc-check__box");
          if (box) {
            box.textContent = next === "done" ? "[x]" : next === "failed" ? "[!]" : "[ ]";
          }
        });
      })(items[i]);
    }
  }

  function mount(root) {
    mountCopyButtons(root);
    mountChecklist(root);
  }

  window.ProxmoxComputer = {
    mount: mount,
    mountCopyButtons: mountCopyButtons,
    mountChecklist: mountChecklist
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { mount(document); });
  } else {
    mount(document);
  }
})();
