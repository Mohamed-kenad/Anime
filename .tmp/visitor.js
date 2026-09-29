(function () {
  'use strict';

  var header = document.querySelector('[data-site-header]');
  var updateHeader = function () {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 16);
  };
  updateHeader();
  window.addEventListener('scroll', updateHeader, { passive: true });

  document.addEventListener('click', function (event) {
    var next = event.target.closest('[data-rail-next]');
    var previous = event.target.closest('[data-rail-prev]');
    var trigger = next || previous;
    if (!trigger) return;
    var rail = document.getElementById(trigger.getAttribute(next ? 'data-rail-next' : 'data-rail-prev'));
    if (!rail) return;
    var distance = Math.max(280, Math.round(rail.clientWidth * 0.78));
    if (trigger.getAttribute('data-rail-step') === 'item' && rail.firstElementChild) {
      var railGap = Number.parseFloat(window.getComputedStyle(rail).columnGap) || 0;
      distance = rail.firstElementChild.getBoundingClientRect().width + railGap;
    }
    var rtl = window.getComputedStyle(rail).direction === 'rtl';
    var direction = next ? 1 : -1;
    rail.scrollBy({ left: direction * distance * (rtl ? -1 : 1), behavior: 'smooth' });
  });

  document.querySelectorAll('.az-rail').forEach(function (rail) {
    var previous = document.querySelector('[data-rail-prev="' + rail.id + '"]');
    var next = document.querySelector('[data-rail-next="' + rail.id + '"]');
    if (!previous || !next) return;
    var updateRailEdges = function () {
      var maximum = Math.max(0, rail.scrollWidth - rail.clientWidth);
      var position = Math.min(maximum, Math.abs(rail.scrollLeft));
      previous.disabled = position <= 2;
      next.disabled = maximum <= 2 || position >= maximum - 2;
    };
    rail.addEventListener('scroll', updateRailEdges, { passive: true });
    window.addEventListener('resize', updateRailEdges, { passive: true });
    updateRailEdges();
  });

  var searchForm = document.querySelector('[data-search-form]');
  if (searchForm) {
    searchForm.addEventListener('submit', function (event) {
      var input = searchForm.querySelector('input[name="keywords"]');
      if (!input || input.value.trim().length < 2) {
        event.preventDefault();
        if (input) {
          input.setAttribute('aria-invalid', 'true');
          input.focus();
        }
      }
    });
    searchForm.addEventListener('input', function () {
      var input = searchForm.querySelector('input[name="keywords"]');
      if (input && input.value.trim().length >= 2) input.removeAttribute('aria-invalid');
    });
  }

  var homeSlider = document.querySelector('[data-home-slider]');
  if (homeSlider) {
    var homeSlides = Array.prototype.slice.call(homeSlider.querySelectorAll('[data-home-slide]'));
    var homeDots = Array.prototype.slice.call(homeSlider.querySelectorAll('[data-slider-dot]'));
    var homePrevious = homeSlider.querySelector('[data-slider-previous]');
    var homeNext = homeSlider.querySelector('[data-slider-next]');
    var homeSlideIndex = 0;
    var homeSlideTimer = null;
    var homeSliderAutoplay = homeSlider.getAttribute('data-slider-autoplay') !== '0';
    var homeSlideInterval = Math.max(3000, Number(homeSlider.getAttribute('data-slider-interval')) || 7000);
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var showHomeSlide = function (index) {
      if (!homeSlides.length) return;
      homeSlideIndex = (index + homeSlides.length) % homeSlides.length;
      homeSlides.forEach(function (slide, slideIndex) {
        var active = slideIndex === homeSlideIndex;
        slide.classList.toggle('is-active', active);
        slide.setAttribute('aria-hidden', active ? 'false' : 'true');
        slide.querySelectorAll('a,button,input').forEach(function (control) { control.tabIndex = active ? 0 : -1; });
      });
      homeDots.forEach(function (dot, dotIndex) {
        var active = dotIndex === homeSlideIndex;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    };
    var stopHomeSlider = function () { if (homeSlideTimer) { window.clearInterval(homeSlideTimer); homeSlideTimer = null; } };
    var startHomeSlider = function () {
      stopHomeSlider();
      if (!homeSliderAutoplay || reduceMotion || homeSlides.length < 2 || document.hidden) return;
      homeSlideTimer = window.setInterval(function () { showHomeSlide(homeSlideIndex + 1); }, homeSlideInterval);
    };
    if (homePrevious) homePrevious.addEventListener('click', function () { showHomeSlide(homeSlideIndex - 1); startHomeSlider(); });
    if (homeNext) homeNext.addEventListener('click', function () { showHomeSlide(homeSlideIndex + 1); startHomeSlider(); });
    homeDots.forEach(function (dot) { dot.addEventListener('click', function () { showHomeSlide(Number(dot.getAttribute('data-slider-dot')) || 0); startHomeSlider(); }); });
    homeSlider.addEventListener('mouseenter', stopHomeSlider);
    homeSlider.addEventListener('mouseleave', startHomeSlider);
    homeSlider.addEventListener('focusin', stopHomeSlider);
    homeSlider.addEventListener('focusout', startHomeSlider);
    document.addEventListener('visibilitychange', startHomeSlider);
    showHomeSlide(0);
    startHomeSlider();
  }

  var showcaseSlider = document.querySelector('[data-showcase-slider]');
  if (showcaseSlider) {
    var showcaseViewport = showcaseSlider.querySelector('[data-showcase-viewport]');
    var showcaseCards = showcaseViewport ? Array.prototype.slice.call(showcaseViewport.querySelectorAll('.az-showcase-card')) : [];
    var showcasePrevious = showcaseSlider.querySelector('[data-showcase-previous]');
    var showcaseNext = showcaseSlider.querySelector('[data-showcase-next]');
    var showcaseTimer = null;
    var showcaseAutoplay = showcaseSlider.getAttribute('data-slider-autoplay') !== '0';
    var showcaseInterval = Math.max(3000, Number(showcaseSlider.getAttribute('data-slider-interval')) || 7000);
    var showcaseReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    var showcaseCardWidth = function () {
      return showcaseCards.length ? showcaseCards[0].getBoundingClientRect().width : 0;
    };
    var moveShowcase = function (direction) {
      if (!showcaseViewport || !showcaseCards.length) return;
      var maximum = Math.max(0, showcaseViewport.scrollWidth - showcaseViewport.clientWidth);
      if (maximum < 2) return;
      var signedCurrent = showcaseViewport.scrollLeft;
      var current = Math.abs(signedCurrent);
      var rtl = window.getComputedStyle(showcaseViewport).direction === 'rtl';
      var distance = window.innerWidth <= 575.98
        ? showcaseCardWidth()
        : Math.max(showcaseCardWidth() + 2, showcaseViewport.clientWidth * 0.72);
      if (rtl) {
        if (direction < 0 && current >= maximum - 2) {
          showcaseViewport.scrollTo({ left: 0, behavior: 'smooth' });
          return;
        }
        if (direction > 0 && current <= 2) {
          showcaseViewport.scrollTo({ left: -maximum, behavior: 'smooth' });
          return;
        }
        showcaseViewport.scrollTo({
          left: signedCurrent + (direction * distance),
          behavior: 'smooth'
        });
        return;
      } else {
        if (direction > 0 && current >= maximum - 2) {
          showcaseViewport.scrollTo({ left: 0, behavior: 'smooth' });
          return;
        }
        if (direction < 0 && current <= 2) {
          showcaseViewport.scrollBy({ left: maximum, behavior: 'smooth' });
          return;
        }
      }
      showcaseViewport.scrollTo({ left: signedCurrent + (direction * distance), behavior: 'smooth' });
    };
    var stopShowcase = function () { if (showcaseTimer) { window.clearInterval(showcaseTimer); showcaseTimer = null; } };
    var startShowcase = function () {
      stopShowcase();
      if (!showcaseAutoplay || showcaseReducedMotion || !showcaseViewport || showcaseViewport.scrollWidth <= showcaseViewport.clientWidth || document.hidden) return;
      showcaseTimer = window.setInterval(function () {
        moveShowcase(window.getComputedStyle(showcaseViewport).direction === 'rtl' ? -1 : 1);
      }, showcaseInterval);
    };
    if (showcasePrevious) showcasePrevious.addEventListener('click', function () { stopShowcase(); moveShowcase(-1); });
    if (showcaseNext) showcaseNext.addEventListener('click', function () { stopShowcase(); moveShowcase(1); });
    showcaseSlider.addEventListener('mouseenter', stopShowcase);
    showcaseSlider.addEventListener('mouseleave', startShowcase);
    showcaseSlider.addEventListener('focusin', stopShowcase);
    showcaseSlider.addEventListener('focusout', startShowcase);
    document.addEventListener('visibilitychange', startShowcase);
    window.addEventListener('resize', startShowcase, { passive: true });
    startShowcase();
  }

  document.querySelectorAll('[data-filter-select]').forEach(function (select) {
    select.addEventListener('change', function () {
      if (select.value) window.location.assign(select.value);
    });
  });

  var registerForm = document.getElementById('register-form');
  if (registerForm) {
    var honeypot = registerForm.querySelector('input[name="website"]');
    if (honeypot) honeypot.value = Math.floor(Date.now() / 1000);
  }

  document.querySelectorAll('.az-card__poster img, .az-category-card__image img, .az-hero img, .az-watch-poster img, .az-cast-card img, .az-comment__avatar, .az-series-card__poster img, .az-series-detail-hero__poster img, .az-series-season-nav img, .az-series-season-overview__poster img, .az-series-episode-tile img').forEach(function (image) {
    image.addEventListener('error', function () {
      var fallback = image.getAttribute('data-fallback');
      if (fallback && image.src !== fallback) {
        image.src = fallback;
        return;
      }
      image.classList.add('is-missing');
      image.removeAttribute('src');
    }, { once: true });
  });

  var playbackPage = document.querySelector('[data-playback-page]');
  if (playbackPage) {
    var playerFrame = playbackPage.querySelector('[data-player-frame]');
    var playerIframe = playbackPage.querySelector('[data-player-iframe]');
    var playerLoading = playbackPage.querySelector('[data-player-loading]');
    var playerIdle = playbackPage.querySelector('[data-player-idle]');
    var playerStartButtons = playbackPage.querySelectorAll('[data-player-start]');
    var playerProvider = playbackPage.querySelector('[data-current-provider]');
    var playerStatus = playbackPage.querySelector('[data-player-status]');
    var protectedPlayback = playbackPage.getAttribute('data-playback-protected') === '1';
    var playerLoadTimer = null;
    var activeSourceId = '';
    var playbackSessionId = '';
    var expectedLaunchUrl = '';
    var watchRequestSequence = 0;
    var clearPlayerLoadTimer = function () {
      if (playerLoadTimer) {
        window.clearTimeout(playerLoadTimer);
        playerLoadTimer = null;
      }
    };
    var watchPlayerLoad = function (provider) {
      clearPlayerLoadTimer();
      expectedLaunchUrl = '';
      if (playerIdle) playerIdle.classList.add('is-hidden');
      if (playerLoading) playerLoading.classList.remove('is-ready');
      if (playerStatus) {
        playerStatus.textContent = 'Ø¬Ø§Ø±Ù ØªØ¬ÙÙØ² Ø§ÙØ³ÙØ±ÙØ±: ' + provider;
        playerStatus.classList.remove('is-success', 'is-error');
      }
      playerLoadTimer = window.setTimeout(function () {
        if (playerLoading && !playerLoading.classList.contains('is-ready')) {
          playerLoading.classList.add('is-ready');
          if (playerStatus) {
            playerStatus.textContent = 'Ø§ÙØ³ÙØ±ÙØ± ÙØ³ØªØºØ±Ù ÙÙØªÙØ§ Ø£Ø·ÙÙ â ÙÙÙÙÙ Ø§ÙØ§ÙØªØ¸Ø§Ø± Ø£Ù Ø§Ø®ØªÙØ§Ø± Ø³ÙØ±ÙØ± Ø¢Ø®Ø±.';
            playerStatus.classList.add('is-error');
          }
        }
      }, 12000);
    };
    var markPlayerReady = function () {
      if (protectedPlayback && !activeSourceId) return;
      if (protectedPlayback && (!expectedLaunchUrl || !playerIframe || playerIframe.getAttribute('src') !== expectedLaunchUrl)) return;
      clearPlayerLoadTimer();
      if (playerLoading) playerLoading.classList.add('is-ready');
      if (playerStatus) {
        playerStatus.textContent = 'Ø¬Ø§ÙØ² ÙÙØªØ´ØºÙÙ: ' + (playerProvider ? playerProvider.textContent : 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯');
        playerStatus.classList.remove('is-error');
        playerStatus.classList.add('is-success');
      }
    };
    if (playerIframe) playerIframe.addEventListener('load', markPlayerReady);

    var playerReload = playbackPage.querySelector('[data-player-reload]');
    if (protectedPlayback) {
      var createUrl = playbackPage.getAttribute('data-playback-create-url') || '';
      var playbackCsrf = playbackPage.getAttribute('data-playback-csrf') || '';
      var contentId = playbackPage.getAttribute('data-video-uniq') || '';
      var serverList = playbackPage.querySelector('[data-server-list]');
      var sourceCount = playbackPage.querySelector('[data-source-count]');
      var downloadSection = playbackPage.querySelector('[data-download-section]');
      var downloadGroups = playbackPage.querySelector('[data-download-groups]');
      var downloadCount = playbackPage.querySelector('[data-download-count]');
      var sourceDescriptors = [];
      var sessionPromise = null;

      var playbackErrorText = function (status) {
        if (status === 429) return 'ØªÙ ØªØ¬Ø§ÙØ² Ø¹Ø¯Ø¯ Ø§ÙÙØ­Ø§ÙÙØ§Øª Ø§ÙÙØ¤ÙØª. Ø§ÙØªØ¸Ø± ÙÙÙÙÙØ§ Ø«Ù Ø­Ø§ÙÙ ÙØ±Ø© Ø£Ø®Ø±Ù.';
        if (status === 403) return 'ØªØ¹Ø°Ø± Ø§ÙØªØ­ÙÙ ÙÙ Ø¬ÙØ³Ø© Ø§ÙÙØªØµÙØ­. Ø­Ø¯ÙØ« Ø§ÙØµÙØ­Ø© ÙØ­Ø§ÙÙ ÙØ¬Ø¯Ø¯ÙØ§.';
        return 'ØªØ¹Ø°Ø± ØªØ¬ÙÙØ² Ø±Ø§Ø¨Ø· Ø§ÙØªØ´ØºÙÙ Ø§ÙØ¢Ù. Ø­Ø§ÙÙ ÙØ±Ø© Ø£Ø®Ø±Ù.';
      };
      var setPlaybackError = function (status) {
        clearPlayerLoadTimer();
        if (playerLoading) playerLoading.classList.add('is-ready');
        if (playerStatus) {
          playerStatus.textContent = playbackErrorText(status);
          playerStatus.classList.remove('is-success');
          playerStatus.classList.add('is-error');
        }
      };
      var postPlayback = function (url, body) {
        return window.fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            'Content-Type': 'application/json',
            'X-Playback-CSRF': playbackCsrf
          },
          body: JSON.stringify(body)
        }).then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (payload) {
            if (!response.ok) {
              var error = new Error('playback_request_failed');
              error.status = response.status;
              throw error;
            }
            return payload;
          });
        });
      };
      var createTextNode = function (tag, className, textValue) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        node.textContent = textValue;
        return node;
      };
      var sourceIcon = function (download) {
        var wrapper = createTextNode('span', download ? 'az-download-link__icon' : 'az-server-button__icon', '');
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        var paths = download
          ? ['M12 3v11', 'm8 10 4 4 4-4', 'M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3']
          : ['m9 7 8 5-8 5V7Z'];
        paths.forEach(function (pathData) {
          var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', pathData);
          svg.appendChild(path);
        });
        wrapper.appendChild(svg);
        return wrapper;
      };
      var selectServerButton = function (button, provider) {
        playbackPage.querySelectorAll('[data-source-id][data-source-type="embedded_web"]').forEach(function (item) {
          item.classList.remove('is-active');
          item.setAttribute('aria-selected', 'false');
          var state = item.querySelector('[data-server-state]');
          if (state) state.textContent = 'ÙØªØ§Ø­';
        });
        button.classList.add('is-active');
        button.setAttribute('aria-selected', 'true');
        var activeState = button.querySelector('[data-server-state]');
        if (activeState) activeState.textContent = 'ÙØ´Ø· Ø§ÙØ¢Ù';
        if (playerProvider) playerProvider.textContent = provider;
      };
      var renderSources = function (sources) {
        sourceDescriptors = Array.isArray(sources) ? sources : [];
        var watchSources = sourceDescriptors.filter(function (source) { return source.type === 'embedded_web'; });
        var downloadSources = sourceDescriptors.filter(function (source) { return source.type === 'download'; });
        playerStartButtons.forEach(function (button) { button.disabled = watchSources.length === 0; });
        if (serverList) {
          serverList.textContent = '';
          watchSources.forEach(function (source) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'az-server-button';
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', 'false');
            button.setAttribute('data-source-id', source.id);
            button.setAttribute('data-source-type', 'embedded_web');
            button.appendChild(sourceIcon(false));
            button.appendChild(createTextNode('strong', '', source.provider || 'Ø³ÙØ±ÙØ± ÙØ´Ø§ÙØ¯Ø©'));
            var state = createTextNode('small', '', 'ÙØªØ§Ø­');
            state.setAttribute('data-server-state', '');
            button.appendChild(state);
            button.addEventListener('click', function () {
              if (button.disabled) return;
              selectServerButton(button, source.provider || 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯');
              resolveSource(source.id, source.provider || 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯', 'watch', button, false);
            });
            serverList.appendChild(button);
          });
          if (!watchSources.length) serverList.appendChild(createTextNode('p', 'az-source-empty', 'ÙØ§ ØªÙØ¬Ø¯ Ø³ÙØ±ÙØ±Ø§Øª ÙØ´Ø§ÙØ¯Ø© ÙØªØ§Ø­Ø© Ø­Ø§ÙÙÙØ§.'));
        }
        if (!watchSources.length && playerLoading) {
          if (playerIdle) playerIdle.classList.remove('is-hidden');
          playerLoading.classList.add('is-ready');
          var emptyPlayerText = playerLoading.querySelector('p');
          if (emptyPlayerText) emptyPlayerText.textContent = 'ÙØ§ ØªÙØ¬Ø¯ Ø³ÙØ±ÙØ±Ø§Øª ÙØ´Ø§ÙØ¯Ø© ÙØªØ§Ø­Ø© Ø­Ø§ÙÙÙØ§.';
        }
        if (sourceCount) sourceCount.textContent = watchSources.length + ' ÙØªØ§Ø­';
        if (downloadGroups) {
          downloadGroups.textContent = '';
          var grouped = {};
          downloadSources.forEach(function (source) {
            var key = source.quality || 'other';
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(source);
          });
          Object.keys(grouped).forEach(function (quality) {
            var article = document.createElement('article');
            article.className = 'az-download-group';
            var heading = document.createElement('header');
            heading.className = 'az-download-group__label';
            var qualityLabel = createTextNode('strong', '', '');
            qualityLabel.appendChild(createTextNode('i', '', ''));
            qualityLabel.appendChild(document.createTextNode(quality === 'other' ? 'ØªØ­ÙÙÙ' : 'Ø¬ÙØ¯Ø© ' + quality));
            heading.appendChild(qualityLabel);
            heading.appendChild(createTextNode('small', '', grouped[quality].length + ' Ø³ÙØ±ÙØ±Ø§Øª ÙØªØ§Ø­Ø©'));
            article.appendChild(heading);
            var links = document.createElement('div');
            links.className = 'az-download-links';
            grouped[quality].forEach(function (source) {
              var button = document.createElement('button');
              button.type = 'button';
              button.setAttribute('data-source-id', source.id);
              button.setAttribute('data-source-type', 'download');
              var copy = createTextNode('span', 'az-download-link__copy', '');
              copy.appendChild(createTextNode('strong', '', source.provider || source.label || 'ØªØ­ÙÙÙ'));
              button.appendChild(copy);
              button.appendChild(sourceIcon(true));
              button.addEventListener('click', function () {
                if (button.disabled) return;
                // Reserve the tab inside the trusted click event. Opening it only
                // after the asynchronous resolve request makes Chrome return null
                // with noopener even when it opened the tab; the old fallback then
                // navigated the current page too and consumed the one-use grant twice.
                var downloadWindow = window.open('about:blank', '_blank');
                if (downloadWindow) {
                  downloadWindow.opener = null;
                  try { downloadWindow.document.title = 'Ø¬Ø§Ø±Ù ØªØ¬ÙÙØ² Ø±Ø§Ø¨Ø· Ø§ÙØªØ­ÙÙÙâ¦'; } catch (ignore) {}
                }
                resolveSource(source.id, source.provider || 'Ø§ÙØªØ­ÙÙÙ', 'download', button, false, 0, downloadWindow);
              });
              links.appendChild(button);
            });
            article.appendChild(links);
            downloadGroups.appendChild(article);
          });
        }
        if (downloadCount) downloadCount.textContent = downloadSources.length + ' Ø±Ø§Ø¨Ø· ÙØªØ§Ø­';
        if (downloadSection) {
          downloadSection.classList.remove('is-loading');
          downloadSection.hidden = downloadSources.length === 0;
        }
      };
      var ensureSession = function (force) {
        if (!force && playbackSessionId) return Promise.resolve(playbackSessionId);
        if (!force && sessionPromise) return sessionPromise;
        playbackSessionId = '';
        sessionPromise = postPlayback(createUrl, { content_id: contentId }).then(function (payload) {
          if (typeof payload.session_id !== 'string' || !Array.isArray(payload.sources)) throw new Error('invalid_playback_response');
          playbackSessionId = payload.session_id;
          renderSources(payload.sources);
          return playbackSessionId;
        }).finally(function () { sessionPromise = null; });
        return sessionPromise;
      };
      var resolveSource = function (sourceId, provider, purpose, button, retried, requestSequence, downloadWindow) {
        if (purpose === 'watch' && !requestSequence) {
          watchRequestSequence += 1;
          requestSequence = watchRequestSequence;
          watchPlayerLoad(provider);
        }
        button.disabled = true;
        return ensureSession(false).then(function (sessionId) {
          var url = createUrl + '/' + encodeURIComponent(sessionId) + '/sources/' + encodeURIComponent(sourceId) + '/resolve';
          return postPlayback(url, {});
        }).then(function (payload) {
          if (purpose === 'watch' && requestSequence !== watchRequestSequence) return;
          if (typeof payload.launch_url !== 'string' || payload.launch_url.indexOf('/web-playback/launch/') === -1) throw new Error('invalid_playback_response');
          if (purpose === 'watch' && playerIframe) {
            activeSourceId = sourceId;
            if (playerReload) playerReload.disabled = false;
            expectedLaunchUrl = payload.launch_url;
            playerIframe.src = payload.launch_url;
          } else if (purpose === 'download') {
            if (downloadWindow && !downloadWindow.closed) downloadWindow.location.replace(payload.launch_url);
            else window.location.assign(payload.launch_url);
          }
        }).catch(function (error) {
          if (purpose === 'watch' && requestSequence !== watchRequestSequence) return;
          if (!retried && (error.status === 404 || error.status === 410)) {
            return ensureSession(true).then(function () {
              return resolveSource(sourceId, provider, purpose, button, true, requestSequence, downloadWindow);
            });
          }
          if (purpose === 'download' && downloadWindow && !downloadWindow.closed) downloadWindow.close();
          setPlaybackError(error.status || 0);
        }).finally(function () { button.disabled = false; });
      };

      playerStartButtons.forEach(function (startButton) {
        startButton.addEventListener('click', function () {
          if (startButton.disabled || !serverList) return;
          var firstServer = serverList.querySelector('[data-source-id][data-source-type="embedded_web"]');
          if (firstServer && !firstServer.disabled) firstServer.click();
        });
      });

      ensureSession(false).catch(function (error) {
        if (sourceCount) sourceCount.textContent = 'ØºÙØ± ÙØªØ§Ø­';
        if (serverList) {
          serverList.textContent = '';
          serverList.appendChild(createTextNode('p', 'az-source-empty', playbackErrorText(error.status || 0)));
        }
        setPlaybackError(error.status || 0);
      });

      if (playerReload && playerIframe) {
        playerReload.addEventListener('click', function () {
          if (!activeSourceId || playerReload.disabled) return;
          var selected = playbackPage.querySelector('[data-source-id="' + activeSourceId + '"][data-source-type="embedded_web"]');
          if (!selected) return;
          playerReload.classList.add('is-busy');
          resolveSource(activeSourceId, playerProvider ? playerProvider.textContent : 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯', 'watch', selected, false)
            .finally(function () { playerReload.classList.remove('is-busy'); });
        });
      }
    } else {
      playbackPage.querySelectorAll('[data-server-url]').forEach(function (button) {
        button.addEventListener('click', function () {
          if (!playerIframe || button.classList.contains('is-active')) return;
          playbackPage.querySelectorAll('[data-server-url]').forEach(function (item) {
            item.classList.remove('is-active');
            item.setAttribute('aria-selected', 'false');
            var itemState = item.querySelector('[data-server-state]');
            if (itemState) itemState.textContent = 'ÙØªØ§Ø­';
          });
          button.classList.add('is-active');
          button.setAttribute('aria-selected', 'true');
          var activeState = button.querySelector('[data-server-state]');
          if (activeState) activeState.textContent = 'ÙØ´Ø· Ø§ÙØ¢Ù';
          var provider = button.getAttribute('data-server-provider') || 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯';
          if (playerProvider) playerProvider.textContent = provider;
          watchPlayerLoad(provider);
          playerIframe.src = button.getAttribute('data-server-url');
        });
      });
      if (playerReload && playerIframe) {
        playerReload.addEventListener('click', function () {
          playerReload.classList.add('is-busy');
          window.setTimeout(function () { playerReload.classList.remove('is-busy'); }, 700);
          watchPlayerLoad(playerProvider ? playerProvider.textContent : 'Ø§ÙØ³ÙØ±ÙØ± Ø§ÙÙØ­Ø¯Ø¯');
          playerIframe.src = playerIframe.src;
        });
      }
    }
    var playerFullscreen = playbackPage.querySelector('[data-player-fullscreen]');
    if (playerFullscreen && playerFrame) {
      playerFullscreen.addEventListener('click', function () {
        if (playerFrame.requestFullscreen) playerFrame.requestFullscreen().catch(function () {});
      });
    }
  }

  document.querySelectorAll('[data-recommendation-slider]').forEach(function (slider) {
    var viewport = slider.querySelector('[data-recommendation-viewport]');
    var buttons = Array.prototype.slice.call(slider.querySelectorAll('[data-recommendation-scroll]'));
    if (!viewport || !buttons.length) return;

    var moveRecommendations = function (action) {
      var amount = Math.max(260, Math.round(viewport.clientWidth * .92));
      viewport.scrollBy({
        left: action === 'next' ? -amount : amount,
        behavior: 'smooth'
      });
    };

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        moveRecommendations(button.getAttribute('data-recommendation-scroll'));
      });
    });
    viewport.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      moveRecommendations(event.key === 'ArrowLeft' ? 'next' : 'previous');
    });
  });

  var watchPage = document.querySelector('[data-watch-page]');
  var seriesEpisodeGrid = document.querySelector('[data-series-episode-grid]');
  var seriesEpisodeSearch = document.querySelector('[data-series-episode-search]');
  var seriesEpisodeOrder = document.querySelector('[data-series-episode-order]');
  var seriesEpisodeServerForm = document.querySelector('[data-series-episode-server]');
  var seriesEpisodeResults = document.querySelector('[data-series-episode-results]');
  if (seriesEpisodeServerForm && seriesEpisodeResults) {
    var episodeSearchTimer;
    var episodeRequest;
    var episodeEndpoint = seriesEpisodeServerForm.getAttribute('data-series-episode-endpoint') || seriesEpisodeServerForm.getAttribute('action') || window.location.pathname;
    var cleanEpisodeLocation = function () {
      if (!window.history || !window.history.replaceState) return;
      if (!/[?&](q|order|page)=/.test(window.location.search)) return;
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
    };
    var loadSeriesEpisodes = function (page) {
      var params = new URLSearchParams();
      var orderValue = seriesEpisodeServerForm.querySelector('[data-series-episode-order-value]');
      var query = seriesEpisodeSearch ? seriesEpisodeSearch.value.trim() : '';
      var order = orderValue ? orderValue.value : 'asc';
      params.set('ajax', 'episodes');
      params.set('page', String(page || 1));
      if (query !== '') params.set('q', query);
      if (order === 'desc') params.set('order', 'desc');
      if (episodeRequest) episodeRequest.abort();
      var requestController = new AbortController();
      episodeRequest = requestController;
      seriesEpisodeResults.classList.remove('has-error');
      seriesEpisodeResults.classList.add('is-loading');
      seriesEpisodeResults.setAttribute('aria-busy', 'true');
      fetch(episodeEndpoint + '?' + params.toString(), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        signal: requestController.signal
      }).then(function (response) {
        if (!response.ok) throw new Error('Episode request failed');
        return response.text();
      }).then(function (html) {
        seriesEpisodeResults.innerHTML = html;
      }).catch(function (error) {
        if (error.name !== 'AbortError') seriesEpisodeResults.classList.add('has-error');
      }).then(function () {
        if (episodeRequest === requestController) {
          seriesEpisodeResults.classList.remove('is-loading');
          seriesEpisodeResults.removeAttribute('aria-busy');
        }
      });
    };
    cleanEpisodeLocation();
    seriesEpisodeServerForm.addEventListener('submit', function (event) {
      event.preventDefault();
      loadSeriesEpisodes(1);
    });
    if (seriesEpisodeSearch) seriesEpisodeSearch.addEventListener('input', function () {
      window.clearTimeout(episodeSearchTimer);
      episodeSearchTimer = window.setTimeout(function () { loadSeriesEpisodes(1); }, 450);
    });
    if (seriesEpisodeOrder) seriesEpisodeOrder.addEventListener('click', function () {
      var orderValue = seriesEpisodeServerForm.querySelector('[data-series-episode-order-value]');
      var nextOrder = seriesEpisodeOrder.getAttribute('data-next-order') || 'asc';
      if (orderValue) orderValue.value = nextOrder;
      seriesEpisodeOrder.setAttribute('data-next-order', nextOrder === 'asc' ? 'desc' : 'asc');
      var label = seriesEpisodeOrder.querySelector('span');
      if (label) label.textContent = nextOrder === 'asc' ? 'Ø§ÙØ£ÙØ¯Ù Ø£ÙÙÙØ§' : 'Ø§ÙØ£Ø­Ø¯Ø« Ø£ÙÙÙØ§';
      loadSeriesEpisodes(1);
    });
    seriesEpisodeResults.addEventListener('click', function (event) {
      var link = event.target.closest('.az-pagination a[href]');
      if (!link) return;
      event.preventDefault();
      var targetUrl = new URL(link.href, window.location.href);
      loadSeriesEpisodes(Number(targetUrl.searchParams.get('page')) || 1);
    });
  } else if (seriesEpisodeGrid) {
      var seriesEpisodeEmpty = document.querySelector('[data-series-episode-empty]');
      var seriesEpisodeCards = Array.prototype.slice.call(seriesEpisodeGrid.querySelectorAll('[data-episode-number]'));
      var filterSeriesEpisodes = function () {
        var query = seriesEpisodeSearch ? seriesEpisodeSearch.value.trim().toLocaleLowerCase('ar') : '';
        var visible = 0;
        seriesEpisodeCards.forEach(function (card) {
          var searchable = ((card.getAttribute('data-episode-number') || '') + ' ' + (card.getAttribute('data-episode-title') || '')).toLocaleLowerCase('ar');
          var matches = query === '' || searchable.indexOf(query) !== -1;
          card.hidden = !matches;
          if (matches) visible += 1;
        });
        if (seriesEpisodeEmpty) seriesEpisodeEmpty.hidden = visible !== 0;
      };
      if (seriesEpisodeSearch) seriesEpisodeSearch.addEventListener('input', filterSeriesEpisodes);
      if (seriesEpisodeOrder) seriesEpisodeOrder.addEventListener('click', function () {
        var descending = seriesEpisodeOrder.getAttribute('data-order') === 'asc';
        seriesEpisodeCards.sort(function (left, right) {
          var difference = Number(left.getAttribute('data-episode-number')) - Number(right.getAttribute('data-episode-number'));
          return descending ? -difference : difference;
        }).forEach(function (card) { seriesEpisodeGrid.appendChild(card); });
        seriesEpisodeOrder.setAttribute('data-order', descending ? 'desc' : 'asc');
        var label = seriesEpisodeOrder.querySelector('span');
        if (label) label.textContent = descending ? 'Ø§ÙØ£Ø­Ø¯Ø« Ø£ÙÙÙØ§' : 'Ø§ÙØ£ÙØ¯Ù Ø£ÙÙÙØ§';
      });
  }
  if (!watchPage) return;

  // The detail tabs are intentionally tiny and dependency-free. Keep the story
  // in the initial HTML for indexing, then switch panels without a page reload.
  var detailTabs = Array.prototype.slice.call(watchPage.querySelectorAll('[data-tab-target]'));
  detailTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      var targetId = tab.getAttribute('data-tab-target');
      detailTabs.forEach(function (item) {
        var selected = item === tab;
        item.classList.toggle('is-active', selected);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.setAttribute('tabindex', selected ? '0' : '-1');
      });
      watchPage.querySelectorAll('.az-tab-panel').forEach(function (panel) {
        var selected = panel.id === targetId;
        panel.classList.toggle('is-active', selected);
        panel.hidden = !selected;
      });
    });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      var index = detailTabs.indexOf(tab);
      var step = event.key === 'ArrowRight' ? -1 : 1;
      var next = detailTabs[(index + step + detailTabs.length) % detailTabs.length];
      event.preventDefault();
      next.focus();
      next.click();
    });
  });

  var storyCopy = watchPage.querySelector('[data-story-copy]');
  var storyToggle = watchPage.querySelector('[data-story-toggle]');
  if (storyCopy && storyToggle && storyCopy.scrollHeight > storyCopy.clientHeight + 4) {
    storyToggle.hidden = false;
    storyToggle.addEventListener('click', function () {
      var expanded = storyCopy.classList.toggle('is-expanded');
      storyToggle.textContent = expanded ? 'Ø¹Ø±Ø¶ Ø£ÙÙ' : 'ÙØ±Ø§Ø¡Ø© Ø§ÙÙØµØ© ÙØ§ÙÙØ©';
      storyToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  var articleCopy = watchPage.querySelector('[data-article-copy]');
  var articleToggle = watchPage.querySelector('[data-article-toggle]');
  var articleExpand = watchPage.querySelector('[data-article-expand]');
  if (articleCopy && articleToggle && articleExpand && articleCopy.scrollHeight > articleCopy.clientHeight + 4) {
    articleExpand.classList.add('is-collapsible');
    articleToggle.hidden = false;
    articleToggle.addEventListener('click', function () {
      var expanded = articleCopy.classList.toggle('is-expanded');
      articleExpand.classList.toggle('is-expanded', expanded);
      articleToggle.textContent = expanded ? 'Ø¹Ø±Ø¶ Ø£ÙÙ' : 'Ø¹Ø±Ø¶ Ø§ÙÙØ²ÙØ¯';
      articleToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  }

  var siteRoot = window.location.origin;
  var setStatus = function (element, message, success) {
    if (!element) return;
    element.textContent = message || '';
    element.classList.toggle('is-success', success === true);
    element.classList.toggle('is-error', success === false);
  };

  var seasonExplorer = watchPage.querySelector('[data-season-explorer]');
  if (seasonExplorer) {
    var seasonLinks = Array.prototype.slice.call(seasonExplorer.querySelectorAll('[data-season-link]'));
    var seasonPanel = seasonExplorer.querySelector('[data-season-panel]');
    var seasonStatus = seasonExplorer.querySelector('[data-season-status]');
    var seasonLabel = seasonExplorer.querySelector('[data-season-label]');
    var seasonCount = seasonExplorer.querySelector('[data-season-count]');
    var seasonPanelTitle = seasonExplorer.querySelector('[data-season-panel-title]');
    var seasonPanelCount = seasonExplorer.querySelector('[data-season-panel-count]');
    var seasonEndpoint = seasonExplorer.getAttribute('data-season-endpoint') || '';
    var seasonTabs = seasonExplorer.querySelector('.az-cinema-season-tabs');
    var seasonScrollButtons = Array.prototype.slice.call(seasonExplorer.querySelectorAll('[data-season-scroll]'));
    var episodeJump = seasonExplorer.querySelector('[data-episode-jump]');
    var episodeJumpSubmit = seasonExplorer.querySelector('[data-episode-jump-submit]');
    var episodeOrder = seasonExplorer.querySelector('[data-episode-order]');
    var episodeDescending = false;
    var seasonRequest = 0;

    var episodeNumber = function (link) {
      var number = link && link.querySelector('strong');
      return number ? Number(number.textContent.trim()) || 0 : 0;
    };

    var applyEpisodeOrder = function () {
      var grid = seasonPanel && seasonPanel.querySelector('.az-cinema-episode-grid');
      if (!grid) return;
      var links = Array.prototype.slice.call(grid.querySelectorAll('a'));
      links.sort(function (a, b) {
        return episodeDescending ? episodeNumber(b) - episodeNumber(a) : episodeNumber(a) - episodeNumber(b);
      });
      links.forEach(function (link) { grid.appendChild(link); });
      if (episodeOrder) {
        episodeOrder.setAttribute('aria-pressed', episodeDescending ? 'true' : 'false');
        var label = episodeOrder.querySelector('span');
        if (label) label.textContent = episodeDescending ? 'Ø§ÙØ£Ø­Ø¯Ø« Ø£ÙÙÙØ§' : 'Ø§ÙØ£ÙØ¯Ù Ø£ÙÙÙØ§';
      }
    };

    var jumpToEpisode = function () {
      if (!episodeJump || !seasonPanel) return;
      var wanted = Number(episodeJump.value);
      if (!wanted) {
        episodeJump.focus();
        return;
      }
      var links = Array.prototype.slice.call(seasonPanel.querySelectorAll('.az-cinema-episode-grid a'));
      var target = links.find(function (link) { return episodeNumber(link) === wanted; });
      if (!target) {
        setStatus(seasonStatus, 'ÙØ§ ØªÙØ¬Ø¯ Ø§ÙØ­ÙÙØ© ' + wanted + ' Ø¯Ø§Ø®Ù Ø§ÙÙÙØ³Ù Ø§ÙÙØ¹Ø±ÙØ¶.', false);
        episodeJump.select();
        return;
      }
      setStatus(seasonStatus, '', null);
      window.location.href = target.href;
    };

    var revealCurrentEpisode = function () {
      var currentEpisode = seasonPanel && seasonPanel.querySelector('.az-cinema-episode-grid a.is-current');
      if (!currentEpisode) return;
      var targetTop = currentEpisode.offsetTop - seasonPanel.offsetTop - ((seasonPanel.clientHeight - currentEpisode.offsetHeight) / 2);
      seasonPanel.scrollTop = Math.max(0, targetTop);
    };

    var selectSeason = function (link) {
      var season = link.getAttribute('data-season');
      if (!season || !seasonEndpoint || link.classList.contains('is-active') || seasonExplorer.classList.contains('is-loading')) return;
      var requestId = ++seasonRequest;
      seasonExplorer.classList.add('is-loading');
      seasonPanel.setAttribute('aria-busy', 'true');
      setStatus(seasonStatus, 'Ø¬Ø§Ø±Ù ØªØ­ÙÙÙ Ø­ÙÙØ§Øª Ø§ÙÙÙØ³Ù ' + season + '...', null);

      fetch(seasonEndpoint + '&season=' + encodeURIComponent(season), {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (response) {
        return response.json().catch(function () { return { success: false, msg: 'Ø§Ø³ØªØ¬Ø§Ø¨Ø© ØºÙØ± ØµØ§ÙØ­Ø© ÙÙ Ø§ÙØ®Ø§Ø¯Ù.' }; })
          .then(function (payload) { payload.httpOk = response.ok; return payload; });
      }).then(function (payload) {
        if (requestId !== seasonRequest) return;
        if (!payload.httpOk || !payload.success || !payload.html) throw new Error(payload.msg || 'ØªØ¹Ø°Ø± ØªØ­ÙÙÙ Ø§ÙÙÙØ³Ù.');
        seasonPanel.innerHTML = payload.html;
        seasonPanel.scrollTop = 0;
        applyEpisodeOrder();
        revealCurrentEpisode();
        seasonLinks.forEach(function (item) {
          var selected = item === link;
          item.classList.toggle('is-active', selected);
          item.setAttribute('aria-selected', selected ? 'true' : 'false');
        });
        var total = Number(payload.count) || Number(link.getAttribute('data-season-count')) || 0;
        if (seasonLabel) seasonLabel.textContent = 'Ø§ÙÙÙØ³Ù ' + season;
        if (seasonCount) seasonCount.textContent = total + ' Ø­ÙÙØ©';
        if (seasonPanelTitle) seasonPanelTitle.textContent = 'Ø§ÙÙÙØ³Ù ' + season;
        if (seasonPanelCount) seasonPanelCount.textContent = total + ' Ø­ÙÙØ©';
        if (episodeJump) episodeJump.value = '';
        if (link.scrollIntoView) link.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        setStatus(seasonStatus, '', null);
      }).catch(function (error) {
        if (requestId === seasonRequest) {
          var message = error && error.message && error.message !== 'Failed to fetch'
            ? error.message
            : 'ØªØ¹Ø°Ø± Ø§ÙØ§ØªØµØ§Ù Ø¨Ø§ÙØ®Ø§Ø¯Ù ÙØªØ­ÙÙÙ Ø§ÙÙÙØ³Ù Ø§ÙØ¢Ù.';
          setStatus(seasonStatus, message, false);
        }
      }).finally(function () {
        if (requestId !== seasonRequest) return;
        seasonExplorer.classList.remove('is-loading');
        seasonPanel.setAttribute('aria-busy', 'false');
      });
    };

    seasonLinks.forEach(function (link, index) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        selectSeason(link);
      });
      link.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        var step = event.key === 'ArrowRight' ? -1 : 1;
        var target = seasonLinks[(index + step + seasonLinks.length) % seasonLinks.length];
        event.preventDefault();
        target.focus();
      });
    });

    seasonScrollButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        if (!seasonTabs) return;
        var card = seasonTabs.querySelector('[data-season-link]');
        var gap = Number.parseFloat(window.getComputedStyle(seasonTabs).columnGap) || 7;
        var step = (card ? card.offsetWidth : 112) + gap;
        var visibleCards = Math.max(1, Math.floor((seasonTabs.clientWidth + gap) / step));
        var amount = visibleCards * step;
        var direction = button.getAttribute('data-season-scroll') === 'next' ? -1 : 1;
        seasonTabs.scrollBy({ left: direction * amount, behavior: 'smooth' });
      });
    });

    if (episodeOrder) {
      episodeOrder.addEventListener('click', function () {
        episodeDescending = !episodeDescending;
        applyEpisodeOrder();
        revealCurrentEpisode();
      });
    }

    if (episodeJumpSubmit) episodeJumpSubmit.addEventListener('click', jumpToEpisode);
    if (episodeJump) {
      episodeJump.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        jumpToEpisode();
      });
    }

    seasonExplorer.addEventListener('keydown', function (event) {
      var episode = event.target.closest('.az-cinema-episode-grid a');
      if (!episode) return;
      var grid = episode.closest('.az-cinema-episode-grid');
      var links = Array.prototype.slice.call(grid.querySelectorAll('a'));
      var index = links.indexOf(episode);
      var columns = Math.max(1, Math.round(grid.clientWidth / ((links[0] ? links[0].offsetWidth : 54) + 7)));
      var target = null;
      if (event.key === 'ArrowRight') target = links[index - 1];
      else if (event.key === 'ArrowLeft') target = links[index + 1];
      else if (event.key === 'ArrowUp') target = links[index - columns];
      else if (event.key === 'ArrowDown') target = links[index + columns];
      if (target) { event.preventDefault(); target.focus(); }
    });

    revealCurrentEpisode();
  }

  var memberToken = function () {
    var element = document.getElementById('az-member-token');
    if (!element) return {};
    try { return JSON.parse(element.textContent || '{}'); } catch (error) { return {}; }
  };
  var appendToken = function (data) {
    var token = memberToken();
    if (token._pmnonce) data.set('_pmnonce', token._pmnonce);
    if (token._pmnonce_t) data.set('_pmnonce_t', token._pmnonce_t);
    return data;
  };
  var postJson = function (url, data) {
    return fetch(url, {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest' }
    }).then(function (response) {
      return response.json().catch(function () { return { success: false, msg: 'Ø§Ø³ØªØ¬Ø§Ø¨Ø© ØºÙØ± ØµØ§ÙØ­Ø© ÙÙ Ø§ÙØ®Ø§Ø¯Ù.' }; })
        .then(function (payload) { if (!response.ok && !payload.msg) payload.msg = 'ØªØ¹Ø°Ø± ØªÙÙÙØ° Ø§ÙØ·ÙØ¨.'; return payload; });
    });
  };

  document.querySelectorAll('[data-share-url]').forEach(function (button) {
    button.addEventListener('click', function () {
      var url = button.getAttribute('data-share-url') || window.location.href;
      var title = button.getAttribute('data-share-title') || document.title;
      var status = document.querySelector('[data-watch-status]');
      if (navigator.share) {
        navigator.share({ title: title, url: url }).catch(function () {});
        return;
      }
      navigator.clipboard.writeText(url).then(function () {
        setStatus(status, 'ØªÙ ÙØ³Ø® Ø±Ø§Ø¨Ø· Ø§ÙØµÙØ­Ø©.', true);
      }).catch(function () {
        setStatus(status, 'Ø§ÙØ³Ø® Ø§ÙØ±Ø§Ø¨Ø· ÙÙ Ø´Ø±ÙØ· Ø§ÙØ¹ÙÙØ§Ù.', false);
      });
    });
  });

  var commentForm = document.querySelector('[data-modern-comment-form]');
  if (commentForm) {
    commentForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = commentForm.querySelector('[data-comment-status]');
      var submit = commentForm.querySelector('button[type="submit"]');
      var data = appendToken(new FormData(commentForm));
      data.set('frontend_v2', '1');
      submit.disabled = true;
      setStatus(status, 'Ø¬Ø§Ø±Ù ÙØ´Ø± Ø§ÙØªØ¹ÙÙÙ...', null);
      postJson(siteRoot + '/comment.php', data).then(function (payload) {
        setStatus(status, payload.msg || (payload.cond ? 'ØªÙ ÙØ´Ø± Ø§ÙØªØ¹ÙÙÙ.' : 'ØªØ¹Ø°Ø± ÙØ´Ø± Ø§ÙØªØ¹ÙÙÙ.'), payload.cond === true);
        if (payload.cond) window.setTimeout(function () { window.location.reload(); }, 650);
      }).catch(function () {
        setStatus(status, 'ØªØ¹Ø°Ø± Ø§ÙØ§ØªØµØ§Ù Ø¨Ø§ÙØ®Ø§Ø¯Ù.', false);
      }).finally(function () { submit.disabled = false; });
    });
  }

  document.addEventListener('click', function (event) {
    var actionButton = event.target.closest('[data-comment-action]');
    if (actionButton) {
      var action = actionButton.getAttribute('data-comment-action');
      var data = appendToken(new FormData());
      data.set('p', 'comments'); data.set('do', action); data.set('comment_id', actionButton.getAttribute('data-comment-id'));
      actionButton.disabled = true;
      postJson(siteRoot + '/ajax.php', data).then(function (payload) {
        if (!payload.success) return;
        if (action === 'like' || action === 'dislike') {
          var card = actionButton.closest('[data-comment-id]');
          var like = card && card.querySelector('[data-comment-action="like"] [data-vote-count]');
          var dislike = card && card.querySelector('[data-comment-action="dislike"] [data-vote-count]');
          if (like) like.textContent = payload.up_vote_count || 0;
          if (dislike) dislike.textContent = payload.down_vote_count || 0;
        }
        actionButton.classList.toggle('is-active');
      }).finally(function () { actionButton.disabled = false; });
      return;
    }

    var pageButton = event.target.closest('[data-comment-page]');
    if (pageButton && !pageButton.disabled) {
      var container = document.querySelector('[data-comments-container]');
      var page = pageButton.getAttribute('data-comment-page');
      pageButton.disabled = true;
      fetch(siteRoot + '/ajax.php?p=comments&do=show_comments&format=modern&page=' + encodeURIComponent(page) + '&vid=' + encodeURIComponent(watchPage.getAttribute('data-video-uniq')), { credentials: 'same-origin' })
        .then(function (response) { return response.json(); })
        .then(function (payload) { if (payload.success && container) { container.innerHTML = payload.html; container.scrollIntoView({ behavior: 'smooth', block: 'start' }); } })
        .finally(function () { pageButton.disabled = false; });
    }
  });

  var reportForm = document.querySelector('[data-report-form]');
  if (reportForm) {
    reportForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = reportForm.querySelector('[data-report-status]');
      var submit = reportForm.querySelector('button[type="submit"]');
      var data = appendToken(new FormData(reportForm));
      submit.disabled = true;
      setStatus(status, 'Ø¬Ø§Ø±Ù Ø¥Ø±Ø³Ø§Ù Ø§ÙØ¨ÙØ§Øº...', null);
      postJson(siteRoot + '/ajax.php', data).then(function (payload) {
        setStatus(status, payload.msg || 'ØªØ¹Ø°Ø± Ø¥Ø±Ø³Ø§Ù Ø§ÙØ¨ÙØ§Øº.', payload.success === true);
      }).catch(function () { setStatus(status, 'ØªØ¹Ø°Ø± Ø§ÙØ§ØªØµØ§Ù Ø¨Ø§ÙØ®Ø§Ø¯Ù.', false); })
        .finally(function () { submit.disabled = false; });
    });
  }

  document.querySelectorAll('[data-playlist-action]').forEach(function (button) {
    button.addEventListener('click', function () {
      var status = document.querySelector('[data-playlist-status]');
      var data = appendToken(new FormData());
      data.set('p', 'playlists'); data.set('do', button.getAttribute('data-playlist-action'));
      data.set('playlist-id', button.getAttribute('data-playlist-id')); data.set('video-id', watchPage.getAttribute('data-video-id'));
      button.disabled = true;
      postJson(siteRoot + '/ajax.php', data).then(function (payload) {
        if (!payload.success) { setStatus(status, payload.msg || 'ØªØ¹Ø°Ø± ØªØ¹Ø¯ÙÙ Ø§ÙÙØ§Ø¦ÙØ©.', false); return; }
        var wasAdded = button.getAttribute('data-playlist-action') === 'remove-from-playlist';
        button.setAttribute('data-playlist-action', wasAdded ? 'add-to-playlist' : 'remove-from-playlist');
        button.classList.toggle('is-added', !wasAdded);
        button.querySelector('strong').textContent = wasAdded ? 'Ø¥Ø¶Ø§ÙØ© +' : 'ÙØ­ÙÙØ¸ â';
        setStatus(status, wasAdded ? 'ØªÙØª Ø¥Ø²Ø§ÙØ© Ø§ÙÙÙØ¯ÙÙ ÙÙ Ø§ÙÙØ§Ø¦ÙØ©.' : 'ØªÙ Ø­ÙØ¸ Ø§ÙÙÙØ¯ÙÙ ÙÙ Ø§ÙÙØ§Ø¦ÙØ©.', true);
      }).finally(function () { button.disabled = false; });
    });
  });

  var playlistCreate = document.querySelector('[data-playlist-create]');
  if (playlistCreate) {
    playlistCreate.addEventListener('submit', function (event) {
      event.preventDefault();
      var status = document.querySelector('[data-playlist-status]');
      var submit = playlistCreate.querySelector('button[type="submit"]');
      var data = appendToken(new FormData(playlistCreate));
      data.set('p', 'playlists'); data.set('do', 'create-playlist'); data.set('sorting', 'added');
      data.set('video-id', watchPage.getAttribute('data-video-id')); data.set('ui', 'video-watch');
      submit.disabled = true;
      postJson(siteRoot + '/ajax.php', data).then(function (payload) {
        setStatus(status, payload.msg || (payload.success ? 'ØªÙ Ø¥ÙØ´Ø§Ø¡ Ø§ÙÙØ§Ø¦ÙØ©.' : 'ØªØ¹Ø°Ø± Ø¥ÙØ´Ø§Ø¡ Ø§ÙÙØ§Ø¦ÙØ©.'), payload.success === true);
        if (payload.success) window.setTimeout(function () { window.location.reload(); }, 650);
      }).finally(function () { submit.disabled = false; });
    });
  }
  // Scroll-to-top button
  var scrollTopBtn = document.createElement('button');
  scrollTopBtn.className = 'az-scroll-top';
  scrollTopBtn.setAttribute('aria-label', 'Ø§ÙØ¹ÙØ¯Ø© ÙÙØ£Ø¹ÙÙ');
  scrollTopBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.appendChild(scrollTopBtn);

  var toggleScrollTop = function () {
    scrollTopBtn.classList.toggle('is-visible', window.scrollY > 400);
  };
  window.addEventListener('scroll', toggleScrollTop, { passive: true });
  toggleScrollTop();

  scrollTopBtn.addEventListener('click', function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Scroll reveal animations for sections
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.setAttribute('data-revealed', '');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.az-section, .az-watch-section, .az-discovery').forEach(function (el) {
      el.style.opacity = '0';
      revealObserver.observe(el);
    });
  }

}());
