/* ═══════════════════════════════════════════════════════════════
   DeskFlow AI — TextType Component (Vanilla JS)
   Premium typing animation with GSAP-powered transitions
═══════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  function TextType(options) {
    this.el             = typeof options.el === 'string' ? document.querySelector(options.el) : options.el;
    this.wrap           = typeof options.wrap === 'string' ? document.querySelector(options.wrap) : (options.wrap || null);
    this.words          = options.words          || [];
    this.textColors     = options.textColors     || ['#D4AF37'];
    this.typingSpeed    = options.typingSpeed    || 75;
    this.deletingSpeed  = options.deletingSpeed  || 40;
    this.pauseDuration  = options.pauseDuration  || 1800;
    this.loop           = options.loop !== false;
    this.onWordChange   = options.onWordChange   || null;

    this._wordIdx  = 0;
    this._charIdx  = 0;
    this._deleting = false;
    this._timer    = null;
    this._colorIdx = 0;

    if (this.el && this.words.length) {
      this._applyColor();
      this._tick();
    }
  }

  TextType.prototype._applyColor = function () {
    var c = this.textColors[this._colorIdx % this.textColors.length];
    var glowMap = {
      '#D4AF37': '0 0 24px rgba(212,175,55,.6), 0 0 48px rgba(212,175,55,.22)',
      '#F7E7CE': '0 0 24px rgba(247,231,206,.45), 0 0 48px rgba(247,231,206,.16)',
      '#0F5A5E': '0 0 24px rgba(15,90,94,.9), 0 0 48px rgba(45,212,191,.38)',
    };
    if (this.el) {
      this.el.style.color      = c;
      this.el.style.textShadow = glowMap[c] || ('0 0 24px ' + c + '99');
    }
  };

  TextType.prototype._tick = function () {
    var self = this;
    var word = this.words[this._wordIdx % this.words.length];

    if (this._deleting) {
      this._charIdx = Math.max(0, this._charIdx - 1);
    } else {
      this._charIdx = Math.min(word.length, this._charIdx + 1);
    }

    if (this.el) this.el.textContent = word.substring(0, this._charIdx);

    var delay = this._deleting ? this.deletingSpeed : this.typingSpeed;

    if (!this._deleting && this._charIdx === word.length) {
      /* Full word typed — pause then delete */
      delay = this.pauseDuration;
      this._deleting = true;
    } else if (this._deleting && this._charIdx === 0) {
      /* Word cleared — advance to next */
      this._deleting = false;
      this._wordIdx  = (this._wordIdx + 1) % this.words.length;
      this._colorIdx = (this._colorIdx + 1) % this.textColors.length;
      this._applyColor();
      if (this.onWordChange) this.onWordChange(this._wordIdx, this.words[this._wordIdx]);
      delay = 190;
    }

    this._timer = setTimeout(function () { self._tick(); }, delay);
  };

  TextType.prototype.destroy = function () {
    if (this._timer) clearTimeout(this._timer);
  };

  global.TextType = TextType;

})(window);
