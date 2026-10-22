/**
 * dsh-attention-group — browser half.
 *
 * Adds a global 「群聊」 entry to the sidebar (beside 插件 / 自动化任务 / 任务记忆)
 * and the panel it addresses, so a room can be read, written and CONFIGURED
 * without going through an agent turn.
 *
 * Two slots, because the sidebar owns the button and the main column owns the
 * body: the list id in `sidebar.panellist` ADDRESSES the matching `main` panel.
 *
 * Data comes from this package's own host route (`/attention-group`) — the same
 * shape `dsh-groupchat` uses. The client holds no state worth keeping: every
 * render asks the host, so two windows cannot disagree about a room.
 *
 * Two rules this file follows, both paid for on 2026-10-16:
 *
 *  1. A FAILED READ MUST NEVER LOOK LIKE AN EMPTY ROOM. When the route 404'd,
 *     the panel said 「还没有群」 and two debugging rounds went into the wrong
 *     problem. The failure is now stated where the list would be.
 *  2. THE PANEL OFFERS WHATEVER THE HOST DECLARES. Every picker renders the
 *     host's own `knobs` table, so the panel cannot drift behind the host and
 *     cannot invent a value the host would reject.
 *
 * Written as a closure-factory bundle in conservative syntax (`var`, no arrow
 * functions) because the host serves this file verbatim and the browser
 * evaluates it as-is. `test/support/panel-harness.mjs` runs this same file
 * against a React stand-in, so panel changes are checked by `node --test`
 * rather than by asking a human to look.
 */

window.__ModuleLoader__.load({
  id: 'dsh-attention-group',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    var API = '/attention-group'

    /**
     * Read one response body WITHOUT ever losing the HTTP status.
     *
     * C-15: the old order was `json()` first and `response.ok` second, so a
     * proxy's HTML error page replaced the only fact worth knowing — the panel
     * said 「Unexpected token '<', <!DOCTYPE … is not valid JSON」 and HTTP 500
     * never appeared anywhere. The status check now comes first, and the host's
     * own reason is added to it rather than replacing it.
     */
    function readBody(response) {
      var status = response.status
      if (response.ok !== true) {
        return response.json().then(
          function (data) {
            var reason = data !== null && typeof data === 'object' && typeof data.error === 'string' ? data.error : ''
            throw new Error(reason.length > 0 ? reason + '（HTTP ' + status + '）' : 'HTTP ' + status)
          },
          function () {
            throw new Error('HTTP ' + status + '（响应不是 JSON）')
          },
        )
      }
      return response.json().then(
        function (data) {
          if (data === null || typeof data !== 'object') {
            throw new Error('HTTP ' + status + '（响应不是 JSON 对象）')
          }
          if (data.ok !== true) {
            throw new Error(
              typeof data.error === 'string' && data.error.length > 0
                ? data.error
                : 'HTTP ' + status + '（响应里没有 ok:true）',
            )
          }
          return data
        },
        function () {
          throw new Error('HTTP ' + status + '（响应不是 JSON）')
        },
      )
    }

    /** Ask the host for the room list, plus one room's transcript and knobs. */
    function load(groupId) {
      var query = groupId === undefined || groupId === null ? '' : '?group=' + encodeURIComponent(groupId)
      return fetch(API + query, { cache: 'no-store' }).then(readBody)
    }

    /**
     * One write to the host.
     *
     * `action` is always explicit so a new verb can never be mistaken for the
     * default "post a message", and a failed action reports the host's own
     * reason instead of a bare status code.
     */
    function act(payload) {
      return fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(readBody)
    }

    /**
     * Ask the host which sessions could be invited into a room.
     *
     * A SEPARATE read, asked for only when the picker opens: it costs the host one
     * session-log read per candidate (titles live in the session logs), so paying
     * for it on every one of the panel's five-second polls would make an idle
     * panel do constant disk work.
     *
     * `group` is passed so the host can mark the members a room already has. It is
     * optional: without it the list still works, the tags just stay off.
     *
     * @param {string} groupId - the room being edited, or '' for none.
     * @returns {Promise<object>} the host's candidate payload.
     */
    function loadSessions(groupId) {
      var query = groupId === undefined || groupId === null || groupId === '' ? '' : '&group=' + encodeURIComponent(groupId)
      return fetch(API + '?candidates=1' + query, { cache: 'no-store' }).then(readBody)
    }

    /** A display string that can never be the literal word "undefined". */
    function str(value, fallback) {
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return fallback === undefined ? '' : fallback
    }

    /** An error's own words, never the string "undefined" and never "[object Object]". */
    function errorText(error) {
      var message = error === null || error === undefined ? undefined : error.message
      if (typeof message === 'string' && message.length > 0) return message
      if (typeof error === 'string' && error.length > 0) return error
      if (typeof error === 'number' && Number.isFinite(error)) return String(error)
      return '未知错误（宿主没有给出原因）'
    }

    /**
     * true / false / NOT REPORTED — three states, never two.
     *
     * C-09: `=== true ? '开' : '关'` rendered a field the host never sent as
     * 「关」. The screen then stated a value nobody had set (the host's real
     * defaults are 自省=开, 结论沉淀=开), which is the same class of lie as
     * 「读取失败」 rendering as 「还没有群」.
     */
    function tri(value) {
      if (value === true) return '开'
      if (value === false) return '关'
      return '—（宿主未报告）'
    }

    /** A count the host reported, or an explicit gap where it reported none. */
    function countOf(value) {
      return countKnown(value) ? String(value) : '—'
    }

    function countKnown(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /**
     * Compact token/char count for the dashboard: 950 / 12.3k / 1.2M.
     *
     * These numbers are ESTIMATES (see `roomStats` on the host). Every place that
     * renders one says 「估算」 next to it, so the number can never be mistaken
     * for a bill.
     */
    function bigCount(value) {
      if (!countKnown(value) || value < 0) return '—'
      if (value < 1000) return String(Math.round(value))
      if (value < 1000 * 1000) return (value / 1000).toFixed(value < 100000 ? 1 : 0) + 'k'
      return (value / 1000000).toFixed(1) + 'M'
    }

    /**
     * Text safe to hand to React as a child.
     *
     * A knob table that arrives malformed must not be able to blank the page:
     * in real React an object child throws "Objects are not valid as a React
     * child", which unmounts the whole panel rather than one bad row.
     */
    function safeText(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return ''
    }

    /** The raw value named honestly, for when no label can be trusted. */
    function unknownText(value) {
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'string') return '空字符串'
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return '未报告'
    }

    /** The host's own option object for a value, or null. */
    function knobOption(options, value) {
      var list = Array.isArray(options) ? options : []
      for (var i = 0; i < list.length; i += 1) {
        var option = list[i]
        if (option !== null && typeof option === 'object' && option.value === value) return option
      }
      return null
    }

    /**
     * The host's own label for a knob value.
     *
     * C-09: when the value is not in the host's table the panel now says the
     * RAW value and admits it does not know it, instead of quietly showing
     * 「跟随」 — a real effort the room is not actually on.
     */
    function knobText(options, value) {
      var option = knobOption(options, value)
      if (option !== null && typeof option.label === 'string' && option.label.length > 0) return option.label
      return unknownText(value) + '（面板不认识的值）'
    }

    /**
     * C-02: the contract sends `keywords` as an ARRAY.
     *
     * The panel used to POST a string, and `relay.js` normalizes only arrays —
     * so the keywords were silently dropped, the link was stored with none, and
     * it could never relay anything while the UI said it had been created.
     * Splitting happens here, on the human's text, where the intent is known.
     */
    function keywordList(text) {
      var raw = typeof text === 'string' ? text : ''
      return raw
        .split(/[\n,，]/u)
        .map(function (part) {
          return part.trim()
        })
        .filter(function (part) {
          return part.length > 0
        })
    }

    /**
     * C-02b: render a list value whatever shape it is in.
     *
     * A ledger written by the old panel holds a STRING, and `(value || []).join`
     * threw inside render — in real React that is a blank page, not one bad row.
     * Nothing here may produce the literal "[object Object]" either.
     *
     * @param {*} value - an array, a string, or anything else.
     * @param {string} separator - how to join an array.
     * @returns {string} printable text, never "undefined".
     */
    function listText(value, separator) {
      if (Array.isArray(value)) {
        return value
          .map(function (item) {
            if (typeof item === 'string') return item
            if (typeof item === 'number' && Number.isFinite(item)) return String(item)
            return ''
          })
          .filter(function (item) {
            return item.length > 0
          })
          .join(separator)
      }
      if (typeof value === 'string') return value
      return ''
    }

    /** Keywords are shown separated by a slash, because they are alternatives. */
    function keywordsText(value) {
      return listText(value, ' / ')
    }

    /**
     * C-07: what the host did with this message after storing it.
     *
     * The panel's own 「全部转发：这个群每说一句都转发过去」 hint became true once
     * the host relays panel messages too — so the result has to be visible, not
     * just promised.
     */
    function relayNote(data, targets) {
      var rows = Array.isArray(data.relayed) ? data.relayed : []
      if (rows.length === 0) return ''
      var list = Array.isArray(targets) ? targets : []
      var nameOf = function (id) {
        var found = null
        list.forEach(function (row) {
          if (found === null && row !== null && typeof row === 'object' && row.id === id) found = str(row.title, '')
        })
        return found === null || found === '' ? str(id, '?') : found
      }
      var done = []
      var refused = []
      rows.forEach(function (row) {
        if (row === null || typeof row !== 'object') return
        if (row.relayed === true) done.push(nameOf(row.to))
        else refused.push(nameOf(row.to) + '（' + str(row.reason, '宿主没有给出原因') + '）')
      })
      var parts = []
      if (done.length > 0) parts.push('已转发到 ' + done.join('、'))
      if (refused.length > 0) parts.push('未转发：' + refused.join('、'))
      return parts.join('；')
    }

    /**
     * C-05: what an `effort` write actually did to the live sessions.
     *
     * The host has been reporting `liveApplied` / `applied` / `liveReason` all
     * along; the panel read none of them, so 「开关显示成开」 was the only
     * feedback even when zero sessions had changed.
     */
    function effortReport(data) {
      var applied = countKnown(data.applied) ? data.applied : null
      var skipped = countKnown(data.skipped) ? data.skipped : null
      var parts = []
      if (data.liveApplied === false) {
        parts.push('活会话一个也没改：' + str(data.liveReason, '宿主没有给出原因'))
      } else {
        if (applied !== null) parts.push('已改 ' + applied + ' 个活会话')
        if (skipped !== null && skipped > 0) parts.push(skipped + ' 个没有可用路由，被跳过')
        if (applied === 0 && !(skipped !== null && skipped > 0)) {
          parts.push('没有活会话需要改（群强度是「跟随」时不会改任何人）')
        }
        if (applied === null && skipped === null) {
          parts.push('宿主没有报告活会话的改动结果')
        }
      }
      return parts.join('；')
    }

    /**
     * Accept the older member shape, where `members` was a list of bare names.
     *
     * The host half and the browser bundle are served separately, so a page
     * reload can arrive before the process has been restarted. In that window
     * there are no member records to edit — only names. Rendering a blank row per
     * member would read as "the plugin is broken" rather than "a restart is
     * pending", and offering an edit button that cannot know the member's id
     * would send a write the host must refuse. So those rows are shown, named,
     * and locked.
     *
     * @param {object} detail - group detail from the host.
     * @returns {object} the same detail, with usable member rows.
     */
    function withMemberObjects(detail) {
      // C-06: a member list the host did not report must not become a crash.
      // The host now degrades a malformed room instead of failing the whole
      // route, but the panel is the last line of defence: `members.map` on a
      // missing field is a blank page in real React.
      if (!Array.isArray(detail.members)) {
        return Object.assign({}, detail, { members: [], membersUnreported: true })
      }
      var seenString = false
      var normalized = detail.members.map(function (member) {
        if (typeof member !== 'string') return member
        seenString = true
        return { name: member, kind: '', enabled: true, subscribe: [], wakeEffort: '', wakeable: false, isHuman: false, locked: true }
      })
      return Object.assign({}, detail, { members: normalized, membersLocked: seenString })
    }

    function stampOf(value) {
      if (typeof value !== 'string') return ''
      var date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      var pad = function (n) {
        return n < 10 ? '0' + n : String(n)
      }
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    /**
     * How long ago something happened, or an honest "unknown".
     *
     * The 「拉人」 picker shows when each session last did anything, because two
     * sessions can carry the same title. A relative figure is what a person
     * compares at a glance ("this one moved four minutes ago, that one last
     * week"), so both are given: relative while it is recent, a date once it is
     * old.
     *
     * ⚠️ C-09: an ABSENT timestamp must not render as a time. The host reports
     * `''` when it could not stat a session log, and the panel then says so —
     * "0 分钟前" would be a made-up fact.
     *
     * @param {string} value - ISO instant, or '' when the host has none.
     * @returns {string} display text.
     */
    function agoText(value) {
      if (typeof value !== 'string' || value.length === 0) return '活动时间未知'
      var time = new Date(value).getTime()
      if (!Number.isFinite(time)) return '活动时间未知'
      var seconds = Math.floor((Date.now() - time) / 1000)
      if (!Number.isFinite(seconds)) return '活动时间未知'
      // A clock skew between host and browser can put a write slightly ahead.
      if (seconds < 0) seconds = 0
      if (seconds < 60) return '刚刚'
      var minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分钟前'
      var hours = Math.floor(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      var days = Math.floor(hours / 24)
      if (days < 30) return days + ' 天前'
      return stampOf(value)
    }

    /**
     * The title a candidate session should be shown under.
     *
     * A session with no folded title is NOT nameless to its owner — it simply has
     * no title event yet. Printing its id in the title slot would make the list
     * look like the ids it was supposed to replace, so it says 「（无标题会话）」
     * and the row's tooltip still carries the id.
     *
     * @param {object} row - candidate row.
     * @returns {string} display title.
     */
    function candidateTitle(row) {
      var title = safeText(row === null || row === undefined ? '' : row.title)
      if (title.length > 0) return title
      return '（无标题会话）'
    }

    /**
     * Where a candidate lives: the workspace name the host resolved, else the
     * last path segment it reported, else an explicit unknown.
     *
     * @param {object} row - candidate row.
     * @returns {string} display text.
     */
    function candidateWorkspace(row) {
      var workspace = safeText(row === null || row === undefined ? '' : row.workspace)
      if (workspace.length > 0) return workspace
      var cwd = safeText(row === null || row === undefined ? '' : row.cwd)
      if (cwd.length === 0) return '工作区未知'
      var parts = cwd.split(/[\\/]+/u).filter(function (part) {
        return part.length > 0
      })
      return parts.length === 0 ? cwd : parts[parts.length - 1]
    }

    var S = {
      wrap: { display: 'flex', height: '100%', minHeight: 0, fontSize: '13px' },
      list: {
        width: '230px',
        flex: '0 0 230px',
        borderRight: '1px solid rgba(127,127,127,.22)',
        overflowY: 'auto',
        padding: '8px',
        boxSizing: 'border-box',
      },
      // 2026-10-19, from a real screen recording: the room list costs the chat
      // ~230px of width. Folded away it stays a 26px strip that still shows the
      // direction of the fold — the rooms come back with one click.
      listClosed: {
        width: '26px',
        flex: '0 0 26px',
        borderRight: '1px solid rgba(127,127,127,.22)',
        padding: '8px 2px',
        boxSizing: 'border-box',
        overflow: 'hidden',
      },
      listToggle: {
        display: 'block',
        width: '100%',
        padding: '2px 0 6px',
        border: 0,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '1.4',
        opacity: 0.7,
      },
      listHidden: { display: 'none' },
      listItem: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 10px',
        marginBottom: '4px',
        border: 0,
        borderRadius: '8px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      listItemActive: { background: 'rgba(127,127,127,.16)' },
      itemTop: { display: 'flex', alignItems: 'center', gap: '6px' },
      itemTitle: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      itemMeta: { fontSize: '11px', opacity: 0.6, marginTop: '2px' },
      badge: {
        display: 'inline-block',
        minWidth: '18px',
        padding: '0 5px',
        borderRadius: '9px',
        background: '#4d6bfe',
        color: '#fff',
        fontSize: '11px',
        lineHeight: '18px',
        textAlign: 'center',
      },
      body: { flex: '1 1 auto', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 14px',
        borderBottom: '1px solid rgba(127,127,127,.22)',
      },
      headTitle: { fontWeight: 600, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      headMeta: { fontSize: '11px', opacity: 0.62 },
      tabs: { display: 'flex', gap: '4px', padding: '8px 14px 0' },
      tab: {
        padding: '5px 12px',
        border: '1px solid transparent',
        borderRadius: '8px 8px 0 0',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        opacity: 0.65,
      },
      tabActive: {
        opacity: 1,
        background: 'rgba(127,127,127,.14)',
        borderColor: 'rgba(127,127,127,.25)',
        borderBottomColor: 'transparent',
      },
      scroll: { flex: '1 1 auto', overflowY: 'auto', padding: '10px 14px', minHeight: 0 },
      // The transcript and its 「jump to latest」 button share this box: the
      // button must float OVER the scrolled text, not push the text up.
      logWrap: { position: 'relative', flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0 },
      jumpButton: {
        position: 'absolute',
        right: '16px',
        bottom: '12px',
        width: '30px',
        height: '30px',
        borderRadius: '50%',
        border: '1px solid rgba(127,127,127,.4)',
        background: 'rgba(127,127,127,.55)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '12px',
        lineHeight: '1',
        padding: 0,
        boxShadow: '0 1px 4px rgba(0,0,0,.25)',
      },
      row: { marginBottom: '12px' },
      // 2026-10-19: the speaker is what a human looks for while scrolling, so the
      // NAME is blue and normal-sized (13px = the panel's base font) instead of a
      // smaller grey label. The seq/time stay small and grey. `#4d6bfe` stays a
      // literal: it is the one accent this panel is allowed to use (c22).
      meta: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px', marginBottom: '3px' },
      metaTail: { fontSize: '11px', opacity: 0.65 },
      sender: { color: '#4d6bfe', fontSize: '13px', fontWeight: 500 },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      // The composer is a COLUMN: the mention list sits above the box and pushes
      // it up rather than floating over the transcript. An overlay would need an
      // opaque background, and the only theme-safe surface this panel has is a
      // translucent grey (c22) — messages would bleed through it.
      composerWrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 14px',
        borderTop: '1px solid rgba(127,127,127,.22)',
      },
      composer: {
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-end',
      },
      // A textarea, not an input: an <input> physically cannot hold a newline, so
      // Shift+Enter had nowhere to put one.
      composerInput: {
        flex: '1 1 auto',
        minWidth: 0,
        maxHeight: '180px',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.3)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        lineHeight: '1.5',
        resize: 'none',
      },
      mentionList: {
        border: '1px solid rgba(127,127,127,.28)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.10)',
        maxHeight: '180px',
        overflowY: 'auto',
      },
      mentionRow: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      mentionRowActive: {
        display: 'flex',
        alignItems: 'baseline',
        gap: '10px',
        padding: '5px 10px',
        fontSize: '12px',
        cursor: 'pointer',
        background: 'rgba(127,127,127,.20)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      mentionName: { flex: '0 1 auto' },
      mentionHint: { flex: '0 0 auto', fontSize: '11px', opacity: 0.6 },
      mentionNote: { padding: '4px 10px', fontSize: '11px', opacity: 0.7 },
      input: {
        flex: '1 1 auto',
        minWidth: 0,
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.3)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      },
      textarea: {
        width: '100%',
        minHeight: '72px',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.3)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'vertical',
      },
      button: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: 0,
        background: '#4d6bfe',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
      },
      ghost: {
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.32)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
        fontSize: '12px',
      },
      danger: {
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(226,75,74,.5)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary, #E24B4A)',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
        fontSize: '12px',
      },
      hint: { padding: '16px', opacity: 0.7, lineHeight: 1.6 },
      error: { padding: '8px 14px', color: 'var(--dsw-alias-state-error-primary, #E24B4A)', fontSize: '12px', lineHeight: 1.5, wordBreak: 'break-word' },
      // A statement that is not fatal but must not be swallowed (a degraded
      // room, a failed unread write, a relay that was refused).
      notice: { padding: '8px 14px', color: 'var(--dsw-alias-state-warn-primary, #C77700)', fontSize: '12px', lineHeight: 1.5, wordBreak: 'break-word' },
      noteLine: { padding: '0 14px 8px', fontSize: '11px', opacity: 0.7, lineHeight: 1.5, wordBreak: 'break-word' },
      charter: {
        margin: '0 0 10px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.12)',
        fontSize: '12px',
        opacity: 0.85,
        whiteSpace: 'pre-wrap',
      },
      field: { padding: '10px 14px', borderBottom: '1px solid rgba(127,127,127,.14)' },
      fieldHead: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' },
      fieldLabel: { fontWeight: 600 },
      fieldValue: { fontSize: '11px', opacity: 0.6 },
      fieldHint: { fontSize: '11px', opacity: 0.6, lineHeight: 1.5, marginTop: '4px' },
      segmented: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      segment: {
        padding: '4px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,.3)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
      },
      segmentActive: { background: '#4d6bfe', color: '#fff', borderColor: 'transparent' },
      slider: { width: '100%', accentColor: '#4d6bfe' },
      scale: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.55 },
      scaleOn: { opacity: 1, fontWeight: 700 },
      scaleOff: {},
      member: {
        padding: '8px 10px',
        marginBottom: '6px',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.1)',
      },
      memberTop: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      // ⚠️ Names wrap; they do not ellipsize. A member name like
      // `Agent会话群聊专项DSH Agent` is normal here, and cutting it to
      // `Agent会话群聊专项 D` makes two different agents look like one. The row
      // above already wraps, so a long name costs a second line instead of
      // hiding who it is. Reported by the user 2026-10-17.
      memberName: { fontWeight: 600, flex: '1 1 240px', minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' },
      tag: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,.3)',
        opacity: 0.7,
      },
      memberId: { fontSize: '10px', opacity: 0.45, wordBreak: 'break-all', marginTop: '2px' },
      memberRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', flexWrap: 'wrap' },
      small: { flex: '1 1 auto', minWidth: 0, padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,.28)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px' },
      digestBar: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px',
        padding: '8px 14px 0',
        borderTop: '1px solid rgba(127,127,127,.14)',
      },
      digestBox: {
        margin: '8px 14px 0',
        padding: '8px 10px',
        maxHeight: '180px',
        overflowY: 'auto',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.12)',
        fontSize: '11px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      // The 「拉人」 picker. Neutral translucent surfaces only, like every other
      // row in this panel: a theme token here once turned the whole panel into
      // opaque white blocks (see c22), and the accent below is the one literal
      // that is safe in both themes.
      candidateBox: {
        marginTop: '6px',
        border: '1px solid rgba(127,127,127,.22)',
        borderRadius: '8px',
        background: 'rgba(127,127,127,.06)',
        overflow: 'hidden',
      },
      candidateHead: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
        padding: '6px 8px',
        borderBottom: '1px solid rgba(127,127,127,.14)',
        fontSize: '11px',
        opacity: 0.72,
      },
      candidateHeadText: { flex: '1 1 180px', minWidth: 0 },
      candidateScroll: { maxHeight: '260px', overflowY: 'auto' },
      candidateRow: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        border: 0,
        borderTop: '1px solid rgba(127,127,127,.1)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      candidateTitle: { display: 'block', fontWeight: 600, overflowWrap: 'anywhere', wordBreak: 'break-word' },
      candidateMeta: { display: 'block', fontSize: '11px', opacity: 0.62, marginTop: '2px', overflowWrap: 'anywhere' },
      candidateNote: { padding: '6px 8px', fontSize: '11px', lineHeight: 1.5, opacity: 0.8 },
    }

    /** The sidebar button: the sidebar owns the chrome, so this is the icon. */
    function PanelGlyph(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H9l-4 4v-4H6.5A2.5 2.5 0 0 1 4 13.5z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 9, cy: 9.5, r: 1.2, fill: 'currentColor' }),
        h('circle', { cx: 13, cy: 9.5, r: 1.2, fill: 'currentColor' }),
      )
    }

    /** One setting: a label, its current value, an explanation, and a control. */
    function Field(props) {
      return h(
        'div',
        { style: S.field },
        h(
          'div',
          { style: S.fieldHead },
          h('span', { style: S.fieldLabel }, props.label),
          props.value === undefined || props.value === '' ? null : h('span', { style: S.fieldValue }, props.value),
        ),
        props.hint ? h('div', { style: S.fieldHint }, props.hint) : null,
        props.children ? h('div', { style: { marginTop: '6px' } }, props.children) : null,
      )
    }

    /** A one-of-N picker. Each option's own hint is its tooltip. */
    function Segmented(props) {
      // The options come from the host's own knob table — hostile input as far as
      // the panel is concerned, because a malformed one must not blank the page.
      var options = (Array.isArray(props.options) ? props.options : []).filter(function (option) {
        return option !== null && typeof option === 'object'
      })
      return h(
        'div',
        { style: S.segmented },
        options.map(function (option) {
          var active = option.value === props.value
          return h(
            'button',
            {
              key: String(option.value),
              title: safeText(option.hint),
              style: Object.assign({}, S.segment, active ? S.segmentActive : {}),
              onClick: function () {
                props.onPick(option.value)
              },
            },
            safeText(option.label),
          )
        }),
      )
    }

    /** A switch. Rendered as a button so its on/off state is in its own text. */
    function Switch(props) {
      var on = props.value === true
      // C-09: an unreported field is neither on nor off. Saying 「关」 here is a
      // claim about a value the host never sent.
      var unknown = props.value !== true && props.value !== false
      return h(
        'button',
        {
          title: props.hint || '',
          style: Object.assign({}, on ? S.button : S.ghost, { fontSize: '12px', padding: '5px 12px' }),
          onClick: function () {
            props.onPick(!on)
          },
        },
        unknown ? '—（未报告）' : on ? '开' : '关',
      )
    }

    /**
     * The room's ONE reasoning-effort control (R4b).
     *
     * A real range input, not a list of buttons, because the request was a
     * slider: the point is a single continuous-feeling knob for the whole room
     * that the user can drag without thinking about which member it applies to.
     * A member may still override it per row below.
     */
    function EffortSlider(props) {
      var options = (Array.isArray(props.options) ? props.options : []).filter(function (option) {
        return option !== null && typeof option === 'object'
      })
      var index = 0
      for (var i = 0; i < options.length; i += 1) {
        if (options[i].value === props.value) index = i
      }
      var current = options[index] || { label: '', hint: '' }
      return h(
        'div',
        null,
        h('input', {
          type: 'range',
          min: 0,
          max: Math.max(0, options.length - 1),
          step: 1,
          value: index,
          style: S.slider,
          'aria-label': props.label,
          // C-09: with no matching option the slider would sit on notch 0 and
          // silently claim 「跟随」, so it is disabled instead of lying.
          disabled: props.disabled === true,
          onChange: function (event) {
            var picked = options[Number(event.target.value)]
            if (picked !== undefined) props.onPick(picked.value)
          },
        }),
        h(
          'div',
          { style: S.scale },
          options.map(function (option) {
            return h('span', { key: String(option.value), style: option.value === props.value ? S.scaleOn : S.scaleOff }, safeText(option.label))
          }),
        ),
        h('div', { style: S.fieldHint }, safeText(current.hint)),
        props.disabled === true
          ? h('div', { style: S.fieldHint }, '这个值不在宿主声明的强度表里，滑块已禁用 —— 换一个强度会把群的值改掉。')
          : null,
      )
    }

    /** How the host's member kinds read inside the mention list. */
    var MENTION_KIND_TEXT = { session: '会话', user: '用户', admin: '群管理', bot: '机器人', liaison: '沟通员' }

    /** At most this many mention rows are drawn; the rest are counted, not hidden. */
    var MAX_MENTION_ROWS = 12

    /**
     * What the composer's `@` is asking for, if anything.
     *
     * A room addresses people BY NAME, so a misspelt name is not a mention: the
     * message would be stored, nobody would be addressed, and nothing would say
     * so. This only decides WHEN to offer names — `router.js` stays the authority
     * on what counts as a mention.
     *
     * @param {string} draft - the composer text.
     * @returns {{start:number, query:string}|null} offset of the `@` and the text after it.
     */
    function mentionQuery(draft) {
      if (typeof draft !== 'string' || draft.length === 0) return null
      var at = draft.lastIndexOf('@')
      if (at < 0) return null
      var before = at === 0 ? '' : draft.charAt(at - 1)
      // `a@b` is an address, not a mention: the `@` must OPEN a word. Chinese
      // punctuation opens one too, because sentences here rarely put a space
      // before 「@」.
      if (before !== '' && !/[\s，。、！？；：,.;:!?（）()\[\]【】「」『』<>《》"'“”‘’]/u.test(before)) return null
      var tail = draft.slice(at + 1)
      // A line break ends the mention; a space does NOT, because member names in
      // this deployment contain spaces ("Agent会话群聊专项DSH Agent").
      if (tail.length > 40 || /[\r\n]/u.test(tail)) return null
      return { start: at, query: tail }
    }

    /**
     * Who can be named right now.
     *
     * `@所有人` leads the list because it is the one target that is not a member,
     * and its hint carries the room's gate: a person naming everyone deserves to
     * know whether the room switch is on BEFORE they send it (and c16: a switch
     * the host did not report is stated as unknown, never as off).
     *
     * @param {object|null} group - the open room.
     * @param {string} query - the text typed after `@`.
     * @returns {{rows: object[], total: number, omitted: number}} candidates and what was left out.
     */
    function mentionCandidates(group, query) {
      var q = typeof query === 'string' ? query.toLowerCase() : ''
      var rows = []
      if (q === '' || '所有人'.indexOf(q) >= 0) {
        var gate =
          group !== null && group.mentionAll === true
            ? '叫醒全群（只有用户和群管理能发）'
            : group !== null && group.mentionAll === false
              ? '群开关「允许 @所有人」没开：只会存成普通文字'
              : '群开关状态宿主未报告'
        rows.push({ name: '所有人', insert: '@所有人', hint: gate })
      }
      var members = group !== null && Array.isArray(group.members) ? group.members : []
      var named = {}
      var counts = {}
      members.forEach(function (member) {
        var item = member !== null && typeof member === 'object' ? member : {}
        var name = str(item.name, '')
        if (name.length === 0) return
        counts[name] = (counts[name] === undefined ? 0 : counts[name]) + 1
      })
      members.forEach(function (member) {
        var item = member !== null && typeof member === 'object' ? member : {}
        var name = str(item.name, '')
        if (name.length === 0 || named[name] === true) return
        if (q !== '' && name.toLowerCase().indexOf(q) < 0) return
        named[name] = true
        var notes = []
        if (counts[name] > 1) notes.push('重名：@ 会同时叫醒')
        else if (item.isHuman === true) notes.push('用户')
        else notes.push(str(MENTION_KIND_TEXT[str(item.kind, '')], str(item.kind, '成员')))
        if (item.enabled === false) notes.push('休眠中，不会被叫醒')
        rows.push({ name: name, insert: '@' + name, hint: notes.join(' · ') })
      })
      var total = rows.length
      return { rows: rows.slice(0, MAX_MENTION_ROWS), total: total, omitted: Math.max(0, total - MAX_MENTION_ROWS) }
    }

    /**
     * The tokens that mean "everybody", mirroring `MENTION_ALL_TOKENS` in router.js.
     *
     * This is a duplicate on purpose: the browser bundle cannot import the host's
     * router module, and the panel has to predict what the host will do so it can
     * say 「发送并叫醒 10 人」 BEFORE the click. A drift test asserts the two lists
     * agree (`test/panel-client.test.js`), so a token added on one side fails loudly.
     */
    var MENTION_ALL_TOKENS = ['所有人', '全体成员', '全体', 'all', 'everyone']

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    /** Does this draft address the whole room? Same Unicode boundary rule as the host. */
    function draftAddressesAll(draft) {
      if (typeof draft !== 'string' || draft.length === 0) return false
      for (var index = 0; index < MENTION_ALL_TOKENS.length; index += 1) {
        var pattern = new RegExp('(^|[^\\p{L}\\p{N}_@])@' + escapeRegExp(MENTION_ALL_TOKENS[index]) + '(?![\\p{L}\\p{N}_-])', 'iu')
        if (pattern.test(draft)) return true
      }
      return false
    }

    /** Which members this draft names, using the host's own boundary rule. */
    function draftMentions(draft, members) {
      var found = []
      if (typeof draft !== 'string' || draft.length === 0) return found
      var names = []
      ;(Array.isArray(members) ? members : []).forEach(function (member) {
        var item = member !== null && typeof member === 'object' ? member : {}
        var name = str(item.name, '')
        if (name.length > 0) names.push(name)
      })
      // Longest first, so a name that is a prefix of another cannot win by accident.
      names.sort(function (a, b) {
        return b.length - a.length
      })
      names.forEach(function (name) {
        if (found.indexOf(name) >= 0) return
        var pattern = new RegExp('(^|[^\\p{L}\\p{N}_@])@' + escapeRegExp(name) + '(?![\\p{L}\\p{N}_-])', 'u')
        if (pattern.test(draft)) found.push(name)
      })
      return found
    }

    /**
     * Who a panel send would really wake, so the composer can say it before the
     * click instead of after. Mirrors the host's rule: waking must be on for the
     * room, and only NAMED people (or everyone, via @所有人 with the room switch)
     * are woken. The human and disabled members are never targets.
     */
    function wakeTargetsOf(group, draft) {
      var result = { count: 0, names: [], broadcast: false, addressed: false }
      if (group === null || group.wakeEnabled !== true) return result
      var members = Array.isArray(group.members) ? group.members : []
      var named = draftMentions(draft, members)
      var broadcast = draftAddressesAll(draft) && group.mentionAll === true
      var chosen = []
      members.forEach(function (member) {
        var item = member !== null && typeof member === 'object' ? member : {}
        if (item.isHuman === true || item.enabled === false) return
        var name = str(item.name, '')
        if (name.length === 0) return
        if (broadcast || named.indexOf(name) >= 0) chosen.push(name)
      })
      result.names = chosen
      result.count = chosen.length
      result.broadcast = broadcast
      result.addressed = broadcast || named.length > 0
      return result
    }

    /**
     * What the host actually did with a panel message.
     *
     * Reads the host's own `recipients`/`woken` answer instead of assuming that a
     * 200 means somebody was woken (C-16: a sent POST is not a delivery).
     */
    function wakeResultNote(data) {
      if (data === null || typeof data !== 'object') return ''
      var rows = Array.isArray(data.recipients) ? data.recipients : []
      var parts = []
      var deliveredRows = []
      var failedRows = []
      rows.forEach(function (row) {
        if (row !== null && typeof row === 'object' && row.delivered === true) deliveredRows.push(row)
        else failedRows.push(row)
      })
      if (deliveredRows.length > 0) {
        parts.push(
          '已叫醒 ' +
            deliveredRows.length +
            ' 人：' +
            deliveredRows
              .map(function (row) {
                return str(row.name, '?')
              })
              .join('、'),
        )
      }
      if (failedRows.length > 0) {
        var first = failedRows[0] !== null && typeof failedRows[0] === 'object' ? failedRows[0] : {}
        parts.push(
          '没叫醒 ' +
            failedRows.length +
            ' 人（' +
            str(first.name, '?') +
            '：' +
            str(first.note, '宿主没有给出原因') +
            (failedRows.length > 1 ? ' 等' : '') +
            '）',
        )
      }
      if (parts.length === 0 && data.addressed === true) {
        parts.push(
          '这条点名了人，但没有叫醒任何人：' +
            (data.wakeEnabled === true ? '被点名的人无法唤醒或已休眠' : '这个群的「唤醒」是关的'),
        )
      }
      if (typeof data.allMentionNote === 'string' && data.allMentionNote.length > 0) parts.push('@所有人 未生效：' + data.allMentionNote)
      return parts.join('；')
    }

    /**
     * Pure helpers behind the transcript's scroll policy.
     *
     * The panel polls every 5 s, and EVERY poll used to force the log to the
     * bottom — a human scrolling back through history was yanked away even when
     * nothing new had arrived (reported 2026-10-19 from a screen recording).
     * These functions hold the whole decision so `node --test` can pin it
     * without a browser: `follow` = "move to the bottom", `notify` = "unseen
     * messages arrived, light the button up".
     */
    function maxSeqOf(rows) {
      var list = Array.isArray(rows) ? rows : []
      var max = 0
      for (var index = 0; index < list.length; index += 1) {
        var row = list[index]
        var seq = row !== null && typeof row === 'object' ? row.seq : null
        if (typeof seq === 'number' && isFinite(seq) && seq > max) max = seq
      }
      return max
    }

    /** True when the reader is close enough to the bottom to count as "following". */
    function nearBottom(box) {
      if (box === null || box === undefined) return true
      var remaining = box.scrollHeight - box.scrollTop - box.clientHeight
      return !(typeof remaining === 'number' && remaining > 24)
    }

    function planScroll(input) {
      var roomChanged = input.roomChanged === true
      var prevSeq = typeof input.prevSeq === 'number' ? input.prevSeq : null
      var nextSeq = typeof input.nextSeq === 'number' ? input.nextSeq : 0
      var atBottom = roomChanged === true ? true : input.atBottom === true
      var grew = prevSeq !== null && nextSeq > prevSeq
      return {
        roomChanged: roomChanged,
        atBottom: atBottom,
        // Opening a room starts at its newest message; otherwise only a reader
        // who was ALREADY at the bottom gets followed. Scrolling up is a
        // deliberate act and the panel must not undo it.
        follow: roomChanged === true || (grew === true && atBottom === true),
        // New messages while the reader is up in history: leave the view alone,
        // light the 「jump to latest」 button instead.
        notify: grew === true && atBottom === false,
        nextSeq: nextSeq,
      }
    }

    /** The panel body. */
    function GroupPanel() {
      var [state, setState] = useState({
        loading: true,
        // A READ failure and a WRITE failure are different facts and must not
        // wear each other's label: the list says 「读取失败」 and the body says
        // 「操作失败」, and before this split an action error was announced as a
        // read failure (and the other way round).
        error: '',
        actionError: '',
        groups: [],
        groupsUnreported: false,
        // C-01: the host now distinguishes "the ledger could not be read" from
        // "you have no rooms". The panel must carry that distinction to the
        // screen — rendering an unreadable ledger as 「还没有群」 is exactly the
        // bug that cost two debugging rounds on 2026-10-16.
        ledgerUnreadable: false,
        ledgerError: '',
        ledgerRecoveredFrom: '',
        group: null,
        messages: [],
        knobs: { routeModes: [], efforts: [], joinPolicies: [], memberKinds: [], relayModes: [] },
        linkTargets: [],
      })
      var [draft, setDraft] = useState('')
      // The mention list is DERIVED from the draft on every render (see
      // mentionCandidates), so these two are only the highlight and the Esc
      // dismissal — no second copy of "what is open" that could drift.
      var [mentionIndex, setMentionIndex] = useState(0)
      var [mentionMute, setMentionMute] = useState('')
      var [chosen, setChosen] = useState(null)
      var [tab, setTab] = useState('chat')
      var [creating, setCreating] = useState(false)
      var [newRoomTitle, setNewRoomTitle] = useState('')
      var [titleDraft, setTitleDraft] = useState(null)
      var [charterDraft, setCharterDraft] = useState(null)
      var [memberDrafts, setMemberDrafts] = useState({})
      var [memberNameDrafts, setMemberNameDrafts] = useState({})
      var [hopDrafts, setHopDrafts] = useState({})
      var [adding, setAdding] = useState(false)
      var [newMemberId, setNewMemberId] = useState('')
      var [newMemberName, setNewMemberName] = useState('')
      var [newMemberKind, setNewMemberKind] = useState('session')
      // The 「拉人」 picker (2026-10-17). Its list is read lazily, when somebody
      // opens the field, because building it costs the host one session-log read
      // per candidate (titles live there) — not something to pay every poll.
      var [candidates, setCandidates] = useState({
        open: false,
        loading: false,
        error: '',
        rows: [],
        total: 0,
        shown: 0,
        titlesStatus: '',
        untitled: 0,
        timeSource: '',
        timeDetail: '',
        at: 0,
      })
      var [pendingRemove, setPendingRemove] = useState('')
      var [sinkDirDraft, setSinkDirDraft] = useState(null)
      var [exportNote, setExportNote] = useState('')
      // The summary button is ASYNC on purpose: it wakes the room's manager, and
      // the summary comes back only when that turn ends and the manager stores it
      // with attention_record_summary. So the panel reports "requested", never
      // "done" — claiming otherwise would be the classic lie (c7).
      var [summaryNote, setSummaryNote] = useState('')
      var [digestText, setDigestText] = useState('')
      var [linkTarget, setLinkTarget] = useState('')
      var [linkMode, setLinkMode] = useState('conclusion')
      var [linkKeywords, setLinkKeywords] = useState('')
      var [linkWake, setLinkWake] = useState(false)
      var [linkNote, setLinkNote] = useState('')
      var [effortNote, setEffortNote] = useState('')
      var [postNote, setPostNote] = useState('')
      var [readNote, setReadNote] = useState('')
      var [roomGone, setRoomGone] = useState('')
      var logRef = useRef(null)
      // ── transcript scroll state (2026-10-19) ────────────────────────────────
      // `listOpen` folds the room list away; `unseen`/`flash` drive the
      // 「jump to latest」 button (white = nothing waiting, blue/white blink =
      // new messages). The refs mirror the state so effect bodies can read them
      // without re-running the effect that owns them.
      var [listOpen, setListOpen] = useState(true)
      var [unseen, setUnseen] = useState(false)
      var [flash, setFlash] = useState(false)
      var atBottomRef = useRef(true)
      var lastSeqRef = useRef(null)
      var roomIdRef = useRef(null)
      var unseenRef = useRef(false)
      // C-03: only the newest read may paint the screen.
      var latest = useRef(0)
      // C-13: one write per control at a time (see writeOnce).
      var inFlight = useRef({})

      function refresh(groupId) {
        var wanted = groupId === undefined ? chosen : groupId
        latest.current += 1
        var seq = latest.current
        return load(wanted === null ? undefined : wanted)
          .then(function (data) {
            // C-03: a slow answer for a room the user already clicked away from
            // must NOT repaint the screen. Without this, clicking 「慢群」 and then
            // 「快群」 left the slow room's transcript and title on display.
            if (seq !== latest.current) return
            // The transcript lives INSIDE the group detail. The top-level
            // `messages` fallback keeps a freshly-reloaded browser working
            // against a host process that has not been restarted yet — the two
            // halves are served separately, so there IS a window where one is
            // newer than the other, and in that window a missing transcript
            // would look exactly like an empty room.
            var detail = data.group || null
            var rows = null
            if (detail !== null && Array.isArray(detail.messages)) rows = detail.messages
            else if (Array.isArray(data.messages)) rows = data.messages
            if (detail !== null) detail = withMemberObjects(detail)
            // C-01 again: a response that does not carry a room LIST is not a
            // response saying "you have no rooms".
            var groupsUnreported = !Array.isArray(data.groups)
            setState({
              loading: false,
              error: '',
              actionError: '',
              groups: groupsUnreported ? [] : data.groups,
              groupsUnreported: groupsUnreported,
              ledgerUnreadable: data.ledgerUnreadable === true,
              ledgerError: typeof data.ledgerError === 'string' ? data.ledgerError : '',
              ledgerRecoveredFrom: typeof data.ledgerRecoveredFrom === 'string' ? data.ledgerRecoveredFrom : '',
              group: detail,
              messages: rows === null ? [] : rows,
              knobs: data.knobs || { routeModes: [], efforts: [], joinPolicies: [], memberKinds: [], relayModes: [] },
              linkTargets: Array.isArray(data.linkTargets) ? data.linkTargets : [],
            })
          })
          .catch(function (error) {
            if (seq !== latest.current) return
            var message = errorText(error)
            // C-14: the room is gone from disk. Say it ONCE, drop the selection
            // and stop the five-second poll from re-reporting the same error
            // forever. Dropping `chosen` makes the next read a list read, which
            // is the thing that still works.
            if (/unknown group/iu.test(message)) {
              setRoomGone('这个群已被删除。')
              setChosen(null)
              setState(function (prev) {
                return Object.assign({}, prev, { loading: false, error: '', actionError: '', group: null, messages: [] })
              })
              return
            }
            // Keep whatever was already on screen: a transient failure must not
            // also erase the room the user is reading.
            setState(function (prev) {
              return Object.assign({}, prev, { loading: false, error: message })
            })
          })
      }

      useEffect(function () {
        refresh(chosen)
      }, [chosen])

      // The panel is the human's own view, so it polls: another member may post
      // from its own session while this tab sits open.
      useEffect(function () {
        var id = setInterval(function () {
          refresh(chosen)
        }, 5000)
        return function () {
          clearInterval(id)
        }
      }, [chosen])

      useEffect(
        function () {
          var node = logRef.current
          var roomId = state.group === null ? null : state.group.id
          var plan = planScroll({
            roomChanged: roomIdRef.current !== roomId,
            prevSeq: lastSeqRef.current,
            nextSeq: maxSeqOf(state.messages),
            atBottom: atBottomRef.current,
          })
          // No node means this panel is not in a browser (the test harness): the
          // DECISION is still computed, it just has nothing to move.
          if (plan.follow === true && node !== null && node !== undefined) {
            node.scrollTop = node.scrollHeight
          }
          if (plan.roomChanged === true) roomIdRef.current = roomId
          atBottomRef.current = plan.atBottom
          lastSeqRef.current = plan.nextSeq
          if (plan.notify !== unseenRef.current) {
            unseenRef.current = plan.notify
            setUnseen(plan.notify)
          }
        },
        [state.messages, state.group],
      )

      // Blink 「jump to latest」 between blue and white while messages wait.
      // 600 ms: visible, but slow enough not to strobe.
      useEffect(
        function () {
          if (unseen !== true) {
            if (flash === true) setFlash(false)
            return undefined
          }
          var id = setInterval(function () {
            setFlash(function (value) {
              return value !== true
            })
          }, 600)
          return function () {
            clearInterval(id)
          }
        },
        [unseen],
      )

      function onLogScroll() {
        var node = logRef.current
        if (node === null || node === undefined) return
        var near = nearBottom(node)
        atBottomRef.current = near
        if (near === true && unseenRef.current === true) {
          unseenRef.current = false
          setUnseen(false)
        }
      }

      function jumpToLatest() {
        var node = logRef.current
        if (node !== null && node !== undefined) node.scrollTop = node.scrollHeight
        atBottomRef.current = true
        if (unseenRef.current === true) {
          unseenRef.current = false
          setUnseen(false)
        }
      }

      function fail(error) {
        setState(function (prev) {
          return Object.assign({}, prev, { actionError: errorText(error) })
        })
      }

      function again() {
        return refresh(state.group === null ? undefined : state.group.id)
      }

      /** Open a room, and let the host record that the human has now read it. */
      function openRoom(id) {
        setChosen(id)
        setTab('chat')
        setTitleDraft(null)
        setCharterDraft(null)
        setPendingRemove('')
        setSinkDirDraft(null)
        setExportNote('')
        setDigestText('')
        // Every note below describes ONE room's last write. Carrying it into
        // another room would state that room's state with the wrong room's
        // evidence, so opening a room starts with a clean slate.
        setRoomGone('')
        setReadNote('')
        setPostNote('')
        setEffortNote('')
        setLinkNote('')
        setState(function (prev) {
          return Object.assign({}, prev, { actionError: '' })
        })
        // Opening a room is what "reading" it means. A failure here costs an
        // unread count, not the read — so it is not an error banner. But C-12:
        // it was swallowed entirely, and the badge silently stayed at 「未读 2」.
        act({ action: 'read', group: id })
          .then(function () {
            setReadNote('')
          })
          .catch(function (error) {
            setReadNote('未读状态没有同步：' + errorText(error))
          })
      }

      function submit() {
        var text = draft.trim()
        if (text.length === 0 || state.group === null) return
        var room = state.group
        // Say what is about to happen BEFORE the request: waking ten sessions is
        // the one panel action that costs ten turns, and the human is entitled to
        // see that count before they pay for it.
        var targets = wakeTargetsOf(room, text)
        setDraft('')
        setPostNote(targets.count > 0 ? '正在叫醒 ' + targets.count + ' 人…' : '')
        act({ action: 'post', group: room.id, text: text })
          .then(function (data) {
            // C-07/C-16: the host relays panel messages too, and now it also
            // reports who it woke — both have to be shown, not assumed.
            var parts = [wakeResultNote(data), relayNote(data, state.linkTargets)]
            setPostNote(parts.filter(function (part) { return part !== '' }).join('；'))
            return again()
          })
          .catch(fail)
      }

      /**
       * Complete the mention being typed with an exact member name.
       *
       * It replaces `@` plus whatever followed it, so the stored message carries
       * the name the router will actually match — a near-miss would be stored as
       * plain text and address nobody, silently.
       */
      function pickMention(context, candidate) {
        if (context === null || context === undefined || candidate === undefined) return
        setDraft(draft.slice(0, context.start) + candidate.insert + ' ')
        setMentionIndex(0)
        setMentionMute('')
      }

      /** A person must be able to start a room without asking an agent. */
      function createRoom() {
        var title = newRoomTitle.trim()
        if (title.length === 0) return
        setNewRoomTitle('')
        setCreating(false)
        act({ action: 'create', title: title })
          .then(function (data) {
            setChosen(data.groupId)
          })
          .catch(fail)
      }

      /**
       * C-13: one write per control at a time.
       *
       * A toggle's target value is read from `state.group.*`, which does not
       * change until the host answers. Two clicks inside one round trip both
       * read the SAME value, so the panel posted it twice and the room ended up
       * wherever the first click put it while the human believed they had
       * toggled twice. The guard lives in a ref, so it holds even for clicks
       * that arrive before React re-renders.
       */
      function writeOnce(key, run) {
        if (inFlight.current[key] === true) return Promise.resolve(null)
        inFlight.current[key] = true
        var started
        try {
          // Called SYNCHRONOUSLY on purpose: the request must leave on the click,
          // not one microtask later.
          started = run()
        } catch (error) {
          inFlight.current[key] = false
          return Promise.reject(error)
        }
        return Promise.resolve(started).then(
          function (value) {
            inFlight.current[key] = false
            return value
          },
          function (error) {
            inFlight.current[key] = false
            throw error
          },
        )
      }

      /** A key that is unique per control, so one busy switch cannot block another. */
      function controlKey(action, payload) {
        var extra = ''
        if (payload !== null && typeof payload === 'object') {
          if (payload.memberId !== undefined) extra = ':' + String(payload.memberId)
          else if (payload.to !== undefined) extra = ':' + String(payload.to)
        }
        return action + extra
      }

      function setKnob(action, payload) {
        if (state.group === null) return
        var body = Object.assign({ action: action, group: state.group.id }, payload)
        writeOnce(controlKey(action, payload), function () {
          return act(body)
        })
          .then(again)
          .catch(fail)
      }

      function toggleWake() {
        if (state.group === null) return
        setKnob('wake', { wakeEnabled: !(state.group.wakeEnabled === true) })
      }

      function saveTitle() {
        var title = (titleDraft === null ? '' : titleDraft).trim()
        if (title.length === 0 || state.group === null) return
        act({ action: 'rename', group: state.group.id, title: title })
          .then(function () {
            setTitleDraft(null)
            return again()
          })
          .catch(fail)
      }

      function saveCharter() {
        if (state.group === null) return
        var text = charterDraft === null ? state.group.charter : charterDraft
        act({ action: 'charter', group: state.group.id, charter: text })
          .then(function () {
            setCharterDraft(null)
            return again()
          })
          .catch(fail)
      }

      /**
       * U3: let the room's effort knob reach sessions that are alive right now.
       *
       * C-05: the host answers with `liveApplied` / `applied` / `skipped` /
       * `liveReason` — what it ACTUALLY did. Both the slider and this switch go
       * through here, so a partial or empty application is stated instead of
       * being mistaken for success.
       */
      function applyEffort(payload) {
        if (state.group === null) return
        var body = Object.assign({ action: 'effort', group: state.group.id }, payload)
        return writeOnce('effort', function () {
          return act(body)
        })
          .then(function (data) {
            if (data !== null && data !== undefined) setEffortNote(effortReport(data))
            return again()
          })
          .catch(fail)
      }

      function toggleLiveEffort() {
        if (state.group === null) return
        applyEffort({ liveEffort: state.group.liveEffort !== true })
      }

      /** R10: liaisons out of this room. Directed, switchable, and loop-proof. */
      function saveLink() {
        if (state.group === null) return
        // C-11: a click that sends nothing must say why it sent nothing.
        if (linkTarget.length === 0) {
          setLinkNote('请先选一个目标群。')
          return
        }
        setLinkNote('')
        act({
          action: 'link',
          group: state.group.id,
          to: linkTarget,
          mode: linkMode,
          // C-02: an ARRAY, always. A string here is silently dropped by the
          // host and produces a link that looks created and never relays.
          keywords: keywordList(linkKeywords),
          wake: linkWake,
        })
          .then(function () {
            setLinkKeywords('')
            setLinkWake(false)
            return again()
          })
          .catch(fail)
      }

      function patchLink(to, patch) {
        if (state.group === null) return Promise.resolve(null)
        var body = Object.assign({ action: 'link', group: state.group.id, to: to }, patch)
        return writeOnce(controlKey('link', { to: to }), function () {
          return act(body)
        })
          .then(again)
          .catch(fail)
      }

      /** C-16: the host already accepts `maxHops`; the panel had no way to send it. */
      function saveHops(link) {
        if (state.group === null) return
        var raw = hopOf(link).trim()
        var value = Number(raw)
        if (raw.length === 0 || !Number.isFinite(value) || value < 1) {
          setLinkNote('跳数上限必须是不小于 1 的数字。')
          return
        }
        setLinkNote('')
        patchLink(link.to, { maxHops: Math.floor(value) }).then(function () {
          // Drop the draft so the field shows what the HOST stored. The host
          // clamps this value to its own maximum, and showing the number the
          // human typed after the host refused it would be the same lie as
          // 「还没有群」 — the screen would state a value nobody has.
          setHopDrafts(function (prev) {
            var next = Object.assign({}, prev)
            delete next[link.to]
            return next
          })
        })
      }

      /** C-16: the host already accepts `name`; the panel had no way to send it. */
      function saveMemberName(member) {
        if (state.group === null) return
        var name = memberNameOf(member).trim()
        if (name.length === 0) {
          setLinkNote('成员名字不能是空的。')
          return
        }
        setLinkNote('')
        var body = { action: 'member', group: state.group.id, memberId: member.id, name: name }
        writeOnce('member-name:' + String(member.id), function () {
          return act(body)
        })
          .then(function () {
            setMemberNameDrafts(function (prev) {
              var next = Object.assign({}, prev)
              delete next[member.id]
              return next
            })
            return again()
          })
          .catch(fail)
      }

      function dropLink(to) {
        if (state.group === null) return
        writeOnce('unlink:' + String(to), function () {
          return act({ action: 'unlink', group: state.group.id, to: to })
        })
          .then(again)
          .catch(fail)
      }

      /** R9: the free half — a digest with no model and no wake-up. */
      function askDigest(range) {
        if (state.group === null) return
        setDigestText('正在整理…')
        act({ action: 'digest', group: state.group.id, range: range })
          .then(function (data) {
            setDigestText(str(data.text, '（没有内容）'))
          })
          .catch(function (error) {
            setDigestText('')
            fail(error)
          })
      }

      /** R7: the sink's three switches, plus a one-click export. */
      function toggleSink() {
        if (state.group === null) return
        setKnob('sink', { sinkEnabled: state.group.sinkEnabled !== true })
      }

      function toggleSinkMemory() {
        if (state.group === null) return
        setKnob('sink', { sinkMemory: state.group.sinkMemory !== true })
      }

      /** C-16: an unresolved hop draft must not be invented, so an empty one is shown as empty. */
      function hopOf(link) {
        if (Object.prototype.hasOwnProperty.call(hopDrafts, link.to)) return hopDrafts[link.to]
        return countKnown(link.maxHops) ? String(link.maxHops) : ''
      }

      function setHopDraft(to, value) {
        setHopDrafts(function (prev) {
          return Object.assign({}, prev, { [to]: value })
        })
      }

      function memberNameOf(member) {
        if (Object.prototype.hasOwnProperty.call(memberNameDrafts, member.id)) return memberNameDrafts[member.id]
        return str(member.name, '')
      }

      function setMemberNameDraft(memberId, value) {
        setMemberNameDrafts(function (prev) {
          return Object.assign({}, prev, { [memberId]: value })
        })
      }

      function saveSinkDir() {
        if (state.group === null) return
        var value = sinkDirDraft === null ? str(state.group.sinkDir, '') : sinkDirDraft
        act({ action: 'sink', group: state.group.id, sinkDir: value })
          .then(function () {
            setSinkDirDraft(null)
            return again()
          })
          .catch(fail)
      }

      function exportNow() {
        if (state.group === null) return
        setExportNote('正在写…')
        act({ action: 'sinkExport', group: state.group.id })
          .then(function (data) {
            // Show the REAL path the host wrote, not a guess: the whole point of
            // a sink is knowing where the thing went.
            setExportNote('已写入 ' + str(data.path, '(未报告路径)') + '（' + countOf(data.messages) + ' 条）')
            return again()
          })
          .catch(function (error) {
            setExportNote('')
            fail(error)
          })
      }

      /**
       * R9++ (2026-10-21, user request): summarise with the deployment's own
       * model — no 群管理 session, no turn woken anywhere. The host does the
       * model call; the panel only reports what came back.
       */
      function generateSummaryDirect() {
        if (state.group === null) return
        setSummaryNote('正在用部署模型生成摘要…')
        act({ action: 'summaryDirect', group: state.group.id })
          .then(function (data) {
            setSummaryNote(
              '已生成摘要（' +
                countOf(data.messages) +
                ' 条 → ' +
                countOf(data.chars) +
                ' 字，覆盖到第 ' +
                countOf(data.upToSeq) +
                ' 条），写入者：' +
                str(data.summarizerName, '部署模型') +
                (Number.isFinite(data.tokens) ? '，本次约 ' + countOf(data.tokens) + ' tokens' : ''),
            )
            return again()
          })
          .catch(function (error) {
            setSummaryNote('')
            fail(error)
          })
      }

      function generateSummary() {
        if (state.group === null) return
        setSummaryNote('已请求，等群管理写回…')
        act({ action: 'summaryGenerate', group: state.group.id })
          .then(function (data) {
            var head =
              '已请求 ' +
              str(data.summarizerName, '群管理') +
              ' 生成摘要（' + countOf(data.messages) + ' 条，截至第 ' + countOf(data.upToSeq) + ' 条）'
            var tail =
              data.delivered === true
                ? '已投递；它写完后会用 attention_record_summary 登记回群记录'
                : '未投递：' + str(data.note, '原因未报告')
            setSummaryNote(head + ' · ' + tail)
            return again()
          })
          .catch(function (error) {
            setSummaryNote('')
            fail(error)
          })
      }

      function draftOf(member) {
        if (Object.prototype.hasOwnProperty.call(memberDrafts, member.id)) return memberDrafts[member.id]
        // Comma-joined on purpose: this is an EDITABLE field, and the host splits
        // it back on commas. A display-only separator would not round-trip.
        return listText(member.subscribe, ', ')
      }

      function setMemberDraft(memberId, value) {
        setMemberDrafts(function (prev) {
          return Object.assign({}, prev, { [memberId]: value })
        })
      }

      function dropMemberDraft(memberId) {
        setMemberDrafts(function (prev) {
          var next = Object.assign({}, prev)
          delete next[memberId]
          return next
        })
      }

      function saveSubscribe(member) {
        if (state.group === null) return
        var body = { action: 'member', group: state.group.id, memberId: member.id, subscribe: draftOf(member) }
        writeOnce('subscribe:' + String(member.id), function () {
          return act(body)
        })
          .then(function () {
            dropMemberDraft(member.id)
            return again()
          })
          .catch(fail)
      }

      /**
       * Change what kind of member this is. The one kind that really matters is
       * `admin`: it is the member a 群史摘要 is written BY, so a room without one
       * has a 「生成群史摘要」 button that can only refuse (2026-10-20).
       */
      function setMemberKind(member, kind) {
        if (state.group === null) return
        var body = { action: 'memberKind', group: state.group.id, memberId: member.id, kind: kind }
        writeOnce('member-kind:' + String(member.id), function () {
          return act(body)
        })
          .then(again)
          .catch(fail)
      }

      function toggleMemberEnabled(member) {
        if (state.group === null) return
        var body = { action: 'member', group: state.group.id, memberId: member.id, enabled: member.enabled === false }
        writeOnce('member-enabled:' + String(member.id), function () {
          return act(body)
        })
          .then(again)
          .catch(fail)
      }

      /**
       * A name for the invited member that no existing member already answers to.
       *
       * A room addresses people by NAME, so two members with one name are woken
       * together by a single `@名字`. Pre-filling a title that some other member
       * already uses would quietly create that situation on the human's behalf,
       * so a duplicate gets a numeric suffix. The human may still type whatever
       * they like; the panel just must not do it for them.
       */
      function freeMemberName(title) {
        var wanted = typeof title === 'string' ? title.trim() : ''
        if (wanted.length === 0) return ''
        var members = state.group !== null && Array.isArray(state.group.members) ? state.group.members : []
        var taken = {}
        members.forEach(function (member) {
          if (member !== null && typeof member === 'object' && typeof member.name === 'string') taken[member.name] = true
        })
        if (taken[wanted] !== true) return wanted
        for (var index = 2; index < 100; index += 1) {
          var candidate = wanted + ' ' + index
          if (taken[candidate] !== true) return candidate
        }
        return ''
      }

      /**
       * What the picker's filter box currently means.
       *
       * The box doubles as the session-id field: after a pick it holds a full id.
       * Filtering the list by that id would leave exactly one row on screen and
       * make it look like the list broke, so an exact id match means "no filter".
       */
      function candidateFilter() {
        var text = newMemberId.trim()
        if (text.length === 0) return ''
        var rows = Array.isArray(candidates.rows) ? candidates.rows : []
        for (var index = 0; index < rows.length; index += 1) {
          if (safeText(rows[index] === null ? '' : rows[index].id) === text) return ''
        }
        return text.toLowerCase()
      }

      /** The candidate rows worth drawing: usable records, filtered by the box. */
      function visibleCandidates() {
        var rows = (Array.isArray(candidates.rows) ? candidates.rows : []).filter(function (row) {
          return row !== null && typeof row === 'object' && safeText(row.id).length > 0
        })
        var filter = candidateFilter()
        if (filter.length === 0) return rows
        return rows.filter(function (row) {
          var haystack = (safeText(row.id) + ' ' + safeText(row.title) + ' ' + safeText(row.workspace) + ' ' + safeText(row.cwd)).toLowerCase()
          return haystack.indexOf(filter) >= 0
        })
      }

      /** Read the session list, if it is not already fresh. */
      function openCandidates() {
        // While a read is in flight, a second one adds nothing; within 15 s the
        // answer is the same answer. Both are covered here so that typing into the
        // filter box (which calls this on every keystroke) costs at most one read.
        var fresh = candidates.open === true && (candidates.loading === true || Date.now() - candidates.at < 15000)
        if (fresh) return
        setCandidates(function (prev) {
          return Object.assign({}, prev, { open: true, loading: true, error: '' })
        })
        loadSessions(state.group === null ? '' : state.group.id)
          .then(function (data) {
            if (!Array.isArray(data.sessions)) {
              // C-01 again: "the host did not report a list" is not "there are no
              // sessions". The two halves are served separately, so a reload can
              // pair a new panel with a host that has not restarted yet — that is
              // exactly when this happens, and it must say so.
              setCandidates(function (prev) {
                return Object.assign({}, prev, {
                  open: true,
                  loading: false,
                  rows: [],
                  error: '宿主没有报告会话列表（宿主可能还是旧版本，重启 DSH 后就会有）；仍然可以直接粘贴会话 id。',
                  at: Date.now(),
                })
              })
              return
            }
            var rows = data.sessions
            setCandidates({
              open: true,
              loading: false,
              error: '',
              rows: rows,
              total: countKnown(data.total) ? data.total : rows.length,
              shown: countKnown(data.shown) ? data.shown : rows.length,
              titlesStatus: safeText(data.titlesStatus),
              untitled: countKnown(data.untitled) ? data.untitled : 0,
              timeSource: safeText(data.timeSource),
              timeDetail: safeText(data.timeDetail),
              at: Date.now(),
            })
          })
          .catch(function (error) {
            setCandidates(function (prev) {
              return Object.assign({}, prev, {
                open: true,
                loading: false,
                rows: [],
                error: '读不到会话列表：' + errorText(error) + '（仍然可以直接粘贴会话 id）',
                at: Date.now(),
              })
            })
          })
      }

      function closeCandidates() {
        setCandidates(function (prev) {
          if (prev.open !== true && prev.loading !== true) return prev
          return Object.assign({}, prev, { open: false, loading: false })
        })
      }

      /**
       * Use one candidate: its id becomes the member id, and — only when the
       * human has not typed a name — its title becomes the @ name.
       */
      function pickCandidate(row) {
        var id = safeText(row === null || row === undefined ? '' : row.id)
        if (id.length === 0) return
        setNewMemberId(id)
        if (newMemberName.trim().length === 0) setNewMemberName(freeMemberName(safeText(row.title)))
        closeCandidates()
      }

      function addMember() {
        var id = newMemberId.trim()
        if (id.length === 0 || state.group === null) return
        var name = newMemberName.trim()
        act({
          action: 'join',
          group: state.group.id,
          memberId: id,
          memberName: name.length === 0 ? undefined : name,
          kind: newMemberKind,
        })
          .then(function () {
            setNewMemberId('')
            setNewMemberName('')
            closeCandidates()
            setAdding(false)
            return again()
          })
          .catch(fail)
      }

      /**
       * The picker itself: what the host said, in the human's words.
       *
       * Every branch exists because the alternative is a lie this panel has told
       * before (c7): a failed read must not look like an empty list, a capped list
       * must say it is capped, and a session whose activity time could not be read
       * must say so instead of showing 「刚刚」.
       */
      function candidatePanel() {
        if (candidates.open !== true) return null
        var rows = visibleCandidates()
        var notes = []
        var head = '最近会话'
        if (candidates.loading === true) {
          head = '最近会话 · 正在读取…'
        } else if (candidates.error === '') {
          head = '最近会话 · 列出 ' + rows.length + ' 个'
          if (countKnown(candidates.shown) && countKnown(candidates.total) && candidates.total > candidates.shown) {
            notes.push('只显示最近 ' + candidates.shown + ' 个（这个部署共有 ' + candidates.total + ' 个会话）。')
          }
          // Only when the host says it has NO source. A different source is not a
          // problem worth a line; a missing one is.
          if (candidates.timeSource === 'unavailable') {
            notes.push('活动时间读不到：' + str(candidates.timeDetail, '宿主没有给出原因') + '。')
          }
          if (candidates.titlesStatus !== '' && candidates.titlesStatus !== 'ok') {
            notes.push('有会话的标题读不出来（宿主：' + candidates.titlesStatus + '）。')
          } else if (countKnown(candidates.untitled) && candidates.untitled > 0) {
            notes.push('有 ' + candidates.untitled + ' 个会话还没有标题，下面用「（无标题会话）」代替。')
          }
        }

        var body = []
        if (candidates.error !== '') {
          body.push(h('div', { key: 'candidate-error', style: Object.assign({}, S.candidateNote, { opacity: 1 }) }, candidates.error))
        } else if (candidates.loading === true) {
          body.push(h('div', { key: 'candidate-loading', style: S.candidateNote }, '正在读取会话列表…'))
        } else if (rows.length === 0) {
          body.push(
            h(
              'div',
              { key: 'candidate-empty', style: S.candidateNote },
              (Array.isArray(candidates.rows) ? candidates.rows : []).length === 0
                ? '这个部署里还没有会话记录，可以直接粘贴会话 id。'
                : '没有匹配的会话；清空输入框可以看全部。',
            ),
          )
        } else {
          rows.forEach(function (row) {
            var tags = []
            if (row.live === true) tags.push(h('span', { key: 'live', style: S.tag }, '在线'))
            if (row.member === true) tags.push(h('span', { key: 'member', style: S.tag }, '已在群里'))
            if (row.subagent === true) tags.push(h('span', { key: 'subagent', style: S.tag }, '子会话'))
            var cwd = safeText(row.cwd)
            body.push(
              h(
                'button',
                {
                  key: safeText(row.id),
                  style: S.candidateRow,
                  title: safeText(row.id) + (cwd.length === 0 ? '' : '\n' + cwd),
                  onClick: function () {
                    pickCandidate(row)
                  },
                },
                h(
                  'span',
                  { style: S.candidateTitle },
                  candidateTitle(row),
                  tags.length === 0 ? null : h('span', { style: { fontWeight: 400, marginLeft: '6px' } }, tags),
                ),
                h('span', { style: S.candidateMeta }, candidateWorkspace(row) + ' · 最后活动 ' + agoText(row.lastUsedAt)),
              ),
            )
          })
        }

        return h(
          'div',
          { style: S.candidateBox },
          h(
            'div',
            { style: S.candidateHead },
            h('span', { style: S.candidateHeadText }, head),
            h('button', { style: S.ghost, onClick: closeCandidates }, '收起'),
          ),
          notes.length === 0 ? null : h('div', { style: S.candidateNote }, notes.join(' ')),
          h('div', { style: S.candidateScroll }, body),
        )
      }

      if (state.loading) return h('div', { style: S.hint }, '正在读取群聊…')

      var groups = Array.isArray(state.groups) ? state.groups : []
      var knobs = state.knobs
      var countsUnknown = false
      var totalMessages = 0
      var totalUnread = 0
      groups.forEach(function (row) {
        var item = row !== null && typeof row === 'object' ? row : {}
        if (countKnown(item.messages)) totalMessages += item.messages
        else countsUnknown = true
        if (countKnown(item.unread)) totalUnread += item.unread
        else countsUnknown = true
      })

      // ── C-01: what the LIST itself has to say ──────────────────────────────
      // 「读取失败」 and 「还没有群」 are answers to different questions. The panel
      // is only allowed to give the second when the first does not apply.
      var ledgerError = ''
      if (state.error !== '') {
        ledgerError = '读取失败：' + state.error
      } else if (state.groupsUnreported === true) {
        ledgerError = '读取失败：宿主没有报告群列表（响应里的 groups 不是数组）'
      } else if (state.ledgerUnreadable === true) {
        ledgerError = '读取失败：' + str(state.ledgerError, '宿主没有给出原因')
      }
      var ledgerWarn =
        ledgerError === '' && str(state.ledgerRecoveredFrom, '') !== ''
          ? '账本损坏，已备份到 ' + state.ledgerRecoveredFrom + '，当前从空账本开始。'
          : ''
      var listBlocked = ledgerError !== '' || ledgerWarn !== ''

      var list = h(
        'div',
        { style: listOpen === true ? S.list : S.listClosed },
        h(
          'button',
          {
            type: 'button',
            style: S.listToggle,
            'aria-label': listOpen === true ? '收起群聊列表' : '展开群聊列表',
            title: listOpen === true ? '收起群聊列表，给聊天记录让出宽度' : '展开群聊列表：群名 + 未读数',
            onClick: function () {
              setListOpen(!listOpen)
            },
          },
          listOpen === true ? '◀' : '▶',
        ),
        h(
          'div',
          { style: listOpen === true ? {} : S.listHidden },
        // A failed read must never look like an empty room. A 404 panel reading
        // as "you have no groups yet" is exactly what cost two debugging rounds
        // on 2026-10-16, so the failure is stated where the list would be.
        ledgerError !== ''
          ? h('div', { style: Object.assign({}, S.error, { padding: '4px 8px 8px', fontSize: '11px' }) }, ledgerError)
          : null,
        ledgerWarn !== ''
          ? h('div', { style: Object.assign({}, S.notice, { padding: '4px 8px 8px', fontSize: '11px' }) }, ledgerWarn)
          : null,
        roomGone !== '' ? h('div', { style: Object.assign({}, S.notice, { padding: '4px 8px 8px', fontSize: '11px' }) }, roomGone) : null,
        readNote !== '' ? h('div', { style: Object.assign({}, S.fieldHint, { padding: '0 8px 8px' }) }, readNote) : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px 8px' } },
          h(
            'span',
            { style: { flex: '1 1 auto', opacity: 0.6, fontSize: '11px' } },
            // C-09: an unreadable ledger has no counts. 「0 个群 · 0 条」 is the
            // same lie as 「还没有群」, one step milder.
            listBlocked && groups.length === 0
              ? '群数未知 · 条数未知'
              : groups.length + ' 个群 · ' + (countsUnknown ? '条数未知' : totalMessages + ' 条') + (totalUnread > 0 ? ' · 未读 ' + totalUnread : ''),
          ),
          h(
            'button',
            {
              style: Object.assign({}, S.button, { padding: '3px 9px', fontSize: '12px' }),
              title: '新建群',
              onClick: function () {
                setCreating(!creating)
              },
            },
            '＋',
          ),
        ),
        creating
          ? h(
              'div',
              { style: { display: 'flex', gap: '6px', padding: '0 6px 8px' } },
              h('input', {
                style: S.input,
                autoFocus: true,
                value: newRoomTitle,
                placeholder: '群名称',
                onChange: function (event) {
                  setNewRoomTitle(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter') createRoom()
                  if (event.key === 'Escape') setCreating(false)
                },
              }),
              h('button', { style: S.button, onClick: createRoom }, '建'),
            )
          : null,
        groups.length === 0
          ? // An empty list is only ever "you have no rooms" when the read
            // SUCCEEDED. On a failure (or on a ledger the host could not read,
            // or one it recovered from a corrupt backup) the notice above is the
            // whole story, and adding "还没有群" here is exactly the lie that cost
            // two debugging rounds on 2026-10-16.
            listBlocked
            ? null
            : h('div', { style: { padding: '8px 10px', opacity: 0.65 } }, '还没有群。点上面的 ＋ 建一个。')
          : groups.map(function (row, index) {
              var item = row !== null && typeof row === 'object' ? row : {}
              var id = item.id
              var active = state.group !== null && state.group.id === id
              var unread = countKnown(item.unread) ? item.unread : 0
              // C-06: a room the host degraded still gets a row — that is the
              // whole point of degrading instead of failing the request. It just
              // has to SAY it is degraded.
              var metaParts = [countOf(item.memberCount) + ' 人', countOf(item.messages) + ' 条']
              // Dashboard: the room's transcript size at a glance in the list.
              if (countKnown(item.estTokens)) metaParts.push('≈' + bigCount(item.estTokens) + ' tok')
              if (!countKnown(item.memberCount) || !countKnown(item.messages)) metaParts.push('宿主未报告计数')
              if (item.wakeEnabled === true) metaParts.push('唤醒开')
              else if (item.wakeEnabled !== false) metaParts.push('唤醒未报告')
              if (item.messagesUnreadable === true) metaParts.push('记录读取失败')
              if (item.degraded === true) metaParts.push('记录异常')
              var problems = []
              if (item.messagesUnreadable === true) problems.push('消息记录读不出来：' + str(item.messagesError, '宿主没有给出原因'))
              if (item.degraded === true) problems.push('记录字段异常：' + str(item.degradedReason, '宿主没有给出原因'))
              return h(
                'button',
                {
                  key: String(id === undefined ? index : id),
                  title: problems.join('；'),
                  style: Object.assign({}, S.listItem, active ? S.listItemActive : {}),
                  onClick: function () {
                    openRoom(id)
                  },
                },
                h(
                  'div',
                  { style: S.itemTop },
                  h('span', { style: S.itemTitle }, str(item.title, str(id, '（没有 id 的群）'))),
                  unread > 0 ? h('span', { style: S.badge }, String(unread)) : null,
                ),
                h('div', { style: S.itemMeta }, metaParts.join(' · ')),
                item.lastPreview ? h('div', { style: S.itemMeta }, str(item.lastFrom, '?') + '：' + str(item.lastPreview, '')) : null,
              )
            }),
        ),
      )

      var body
      if (state.group === null) {
        body = h(
          'div',
          { style: S.hint },
          h('div', null, '左边选一个群开始看。'),
          h('div', { style: { marginTop: '8px', fontSize: '12px', opacity: 0.8 } }, '每个群的消息都在它自己的记录里，不会进任何人的会话。'),
        )
      } else {
        var group = state.group
        var links = Array.isArray(group.links) ? group.links : []
        // 2026-10-20: a 群史摘要 is written BY a 群管理, and the host refuses the
        // click when the room has none. The panel therefore has to (a) say who
        // the 群管理 is right where the button is, and (b) offer the one click
        // that creates one — otherwise the human sees an error with no way out.
        var memberList = Array.isArray(group.members) ? group.members : []
        var adminMembers = memberList.filter(function (member) {
          return (
            member !== null &&
            typeof member === 'object' &&
            member.kind === 'admin' &&
            member.enabled !== false &&
            member.isHuman !== true
          )
        })
        var promoteCandidates = memberList.filter(function (member) {
          return (
            member !== null &&
            typeof member === 'object' &&
            member.kind === 'session' &&
            member.enabled !== false &&
            member.isHuman !== true
          )
        })
        var routeOption = knobOption(knobs.routeModes, group.routeMode)
        var routeLabel = knobText(knobs.routeModes, group.routeMode)
        var routeHint = routeOption === null ? '' : str(routeOption.hint, '')
        var effortOption = knobOption(knobs.efforts, group.defaultEffort)
        var effortLabel = knobText(knobs.efforts, group.defaultEffort)
        var effortKnown = effortOption !== null
        // C-01/C-06 in the DETAIL: a transcript the host could not read is not
        // an empty room, and a degraded room has to say what was missing.
        var transcriptError =
          group.messagesUnreadable === true
            ? '读取失败：' + str(group.messagesError, '宿主没有给出原因') + '（这个群的记录文件存在，但读不出来）'
            : ''
        var degradedNote =
          group.degraded === true ? '这个群的记录有字段异常，已按安全默认值显示：' + str(group.degradedReason, '宿主没有给出原因') : ''
        // C-10: the host has always reported `truncated`; the panel drew 300 of
        // 305 rows and said nothing at all.
        var truncatedNote =
          group.truncated === true
            ? '只显示最新 300 条（本页 ' +
              state.messages.length +
              ' 条，共 ' +
              countOf(group.messageCount) +
              ' 条）；完整记录在数据目录的 messages/' +
              str(group.id, '?') +
              '.jsonl 里。'
            : ''

        // R3 in the panel: typing `@` offers the room's names. Derived from the
        // draft, so the list the person sees and the text that will be sent can
        // never disagree.
        var mention = mentionQuery(draft)
        var mentionList = mention === null ? { rows: [], total: 0, omitted: 0 } : mentionCandidates(group, mention.query)
        var mentionKey = mention === null ? '' : mention.start + ':' + mention.query
        var mentionRows = mention !== null && mentionMute === mentionKey ? [] : mentionList.rows
        var mentionSelected = mentionRows.length === 0 ? 0 : Math.min(mentionIndex, mentionRows.length - 1)

        // 2026-10-18: the panel now really wakes the people it NAMES, but only
        // when the room's 「唤醒」 switch is on — so the screen has to say which
        // state it is in, and how many turns a send is about to spend.
        var wakeTargets = wakeTargetsOf(group, draft)
        var mentionAllNote =
          group.mentionAll === true
            ? ''
            : '（「允许 @所有人」' + (group.mentionAll === false ? '是关的' : '状态宿主未报告') + '，所以 @所有人 只会存成普通文字。）'
        var wakeNote =
          group.wakeEnabled === true
            ? '唤醒已开：这条消息 @ 到谁就真的叫醒谁' +
              (wakeTargets.count > 0 ? '（现在会叫醒 ' + wakeTargets.count + ' 人：' + wakeTargets.names.join('、') + '）' : '') +
              '；没 @ 人的消息仍然只进群记录，不打扰任何人。' +
              mentionAllNote
            : '面板里发言只进群记录，不叫醒任何人 —— 这个群的「唤醒」是关的。要叫醒被 @ 的人，先把右上角「唤醒」打开。'
        var sendLabel = wakeTargets.count > 0 ? '发送并叫醒 ' + wakeTargets.count + ' 人' : '发送'

        var head = h(
          'div',
          { style: S.head },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: S.headTitle }, str(group.title, str(group.id, '（没有 id 的群）'))),
            h(
              'div',
              { style: S.headMeta },
              countOf(group.members.length) +
                ' 人 · ' +
                countOf(group.messageCount) +
                ' 条 · 路由 ' +
                routeLabel +
                ' · 强度 ' +
                effortLabel +
                (group.stats !== undefined && group.stats !== null && countKnown(group.stats.estTokens)
                  ? ' · 记录 ≈' + bigCount(group.stats.estTokens) + ' tok'
                  : ''),
            ),
          ),
          h(
            'button',
            {
              style: Object.assign({}, group.wakeEnabled === true ? S.button : S.ghost, { padding: '3px 10px', fontSize: '12px' }),
              // C-08: 「被 @ 的成员会被真的叫起来」 was false for anything typed in
              // this panel. Waking needs a TOOL call carrying wake=true.
              title:
                group.wakeEnabled === true
                  ? '唤醒已开：面板里 @ 到谁就真的叫醒谁（@所有人 还要「允许 @所有人」开着）；没 @ 人的消息仍然只进群记录'
                  : '唤醒已关：消息只进群记录，不打扰任何人的会话',
              onClick: toggleWake,
            },
            '唤醒 ' + tri(group.wakeEnabled),
          ),
        )

        var tabs = h(
          'div',
          { style: S.tabs },
          h(
            'button',
            { style: Object.assign({}, S.tab, tab === 'chat' ? S.tabActive : {}), onClick: function () { setTab('chat') } },
            '聊天',
          ),
          h(
            'button',
            { style: Object.assign({}, S.tab, tab === 'settings' ? S.tabActive : {}), onClick: function () { setTab('settings') } },
            '设置',
          ),
        )

        var main
        if (tab === 'chat') {
          main = h(
            'div',
            { style: S.body },
            group.charter ? h('div', { style: Object.assign({}, S.charter, { margin: '10px 14px 0' }) }, group.charter) : null,
            state.error ? h('div', { style: S.error }, '读取失败：' + state.error) : null,
            state.actionError ? h('div', { style: S.error }, '操作失败：' + state.actionError) : null,
            degradedNote !== '' ? h('div', { style: S.notice }, degradedNote) : null,
            h(
              'div',
              { style: S.logWrap },
              h(
                'div',
                { style: S.scroll, ref: logRef, onScroll: onLogScroll },
              truncatedNote !== '' ? h('div', { style: S.fieldHint }, truncatedNote) : null,
              // C-01: an unreadable transcript must never be drawn as an empty
              // room — 「这个群还没有消息。」 for a file that could not be read is
              // the same lie the ledger made, one level down.
              transcriptError !== '' ? h('div', { style: S.error }, transcriptError) : null,
              state.messages.length === 0
                ? transcriptError === ''
                  ? h('div', { style: { opacity: 0.6 } }, '这个群还没有消息。')
                  : null
                : state.messages.map(function (row) {
                    var message = row !== null && typeof row === 'object' ? row : {}
                    return h(
                      'div',
                      { key: String(message.seq), style: S.row },
                      h(
                        'div',
                        { style: S.meta },
                        h('span', { style: S.metaTail }, '#' + str(message.seq, '?') + '  ' + stampOf(message.at)),
                        h('span', { style: S.sender }, str(message.fromName, '?')),
                      ),
                      h('div', { style: S.text }, str(message.text, '')),
                    )
                  }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  'aria-label': '跳到最新消息',
                  title: unseen === true ? '有新消息，点这里回到最新' : '回到最新消息',
                  style: Object.assign({}, S.jumpButton, { color: unseen === true && flash === true ? '#4d6bfe' : '#fff' }),
                  onClick: jumpToLatest,
                },
                '▼',
              ),
            ),
            h(
              'div',
              { style: S.digestBar },
              h('span', { style: S.fieldHint }, '先自己看一眼：'),
              h('button', { style: S.ghost, onClick: function () { askDigest('today') } }, '总结今天'),
              h('button', { style: S.ghost, onClick: function () { askDigest('24h') } }, '最近24小时'),
              h('button', { style: S.ghost, onClick: function () { askDigest('all') } }, '全部'),
              digestText.length > 0
                ? h('button', { style: S.ghost, onClick: function () { setDigestText('') } }, '收起')
                : null,
            ),
            digestText.length > 0 ? h('pre', { style: S.digestBox }, digestText) : null,
            // C-08, rewritten 2026-10-18: the truth has to be in the VISIBLE text,
            // not only a tooltip — and the truth now depends on the room's switch.
            h('div', { style: S.noteLine }, wakeNote),
            postNote !== '' ? h('div', { style: Object.assign({}, S.noteLine, { opacity: 1 }) }, postNote) : null,
            h(
              'div',
              { style: S.composerWrap },
              mentionRows.length > 0
                ? h(
                    'div',
                    { style: S.mentionList, 'aria-label': '选择要 @ 的人' },
                    mentionRows.map(function (row, index) {
                      return h(
                        'div',
                        {
                          key: row.insert,
                          style: index === mentionSelected ? S.mentionRowActive : S.mentionRow,
                          onClick: function () {
                            pickMention(mention, row)
                          },
                        },
                        h('span', { style: S.mentionName }, row.name),
                        row.hint === '' ? null : h('span', { style: S.mentionHint }, row.hint),
                      )
                    }),
                    mentionList.omitted > 0
                      ? h(
                          'div',
                          { style: S.mentionNote },
                          '还有 ' + mentionList.omitted + ' 个没列出来（共 ' + mentionList.total + ' 个）：继续打字可以筛。',
                        )
                      : null,
                  )
                : null,
              h(
                'div',
                { style: S.composer },
                h('textarea', {
                  style: S.composerInput,
                  value: draft,
                  // Grows with the draft up to six lines, then scrolls. Pure
                  // arithmetic, so it is testable and needs no DOM measurement.
                  rows: Math.min(6, Math.max(1, draft.split('\n').length)),
                  placeholder: '以「用户」身份发言（Enter 发送，Shift+Enter 换行，打 @ 点名）',
                  onChange: function (event) {
                    setDraft(event.target.value)
                    setMentionIndex(0)
                  },
                  onKeyDown: function (event) {
                    var native = event.nativeEvent === null || event.nativeEvent === undefined ? {} : event.nativeEvent
                    // A Chinese IME sends Enter to COMMIT a candidate. Sending the
                    // message there would eat the person's text mid-word, so a
                    // composing Enter is never a send.
                    if (event.isComposing === true || native.isComposing === true || event.keyCode === 229) return
                    if (mentionRows.length > 0) {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setMentionIndex((mentionSelected + 1) % mentionRows.length)
                        return
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setMentionIndex((mentionSelected - 1 + mentionRows.length) % mentionRows.length)
                        return
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        setMentionMute(mentionKey)
                        return
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault()
                        pickMention(mention, mentionRows[mentionSelected])
                        return
                      }
                      return
                    }
                    // Shift+Enter is the newline, exactly like the rest of DSH;
                    // plain Enter sends. The textarea is what makes the newline
                    // possible at all — an <input> cannot hold one.
                    if (event.key === 'Enter' && event.shiftKey !== true) {
                      event.preventDefault()
                      submit()
                    }
                  },
                }),
                h('button', { style: S.button, onClick: submit }, sendLabel),
              ),
            ),
          )
        } else {
          var memberRows = group.members.map(function (member) {
            var item = member !== null && typeof member === 'object' ? member : {}
            var confirming = pendingRemove === item.id
            return h(
              'div',
              { key: String(item.id), style: S.member },
              h(
                'div',
                { style: S.memberTop },
                h('span', { style: S.memberName, title: str(item.name, str(item.id, '')) }, str(item.name, str(item.id, '（没有 id 的成员）'))),
                h('span', { style: S.tag }, str(MENTION_KIND_TEXT[item.kind], str(item.kind, 'session'))),
                h('span', { style: S.tag }, item.wakeable === true ? '可唤醒' : '只记录'),
                item.enabled === false ? h('span', { style: S.tag }, '已休眠') : null,
                item.enabled === undefined ? h('span', { style: S.tag }, '启用状态未报告') : null,
                // A row with no member id (the pre-restart shape) gets no controls:
                // a write with a guessed id is a write the host must refuse.
                item.locked === true
                  ? h('span', { style: S.tag }, '重启 DSH 后可管理')
                  : [
                      h(
                        'button',
                        {
                          style: S.ghost,
                          title: item.enabled === false ? '重新启用：它可以被叫醒了' : '休眠：这个成员不再被叫醒，也不占额度',
                          onClick: function () {
                            toggleMemberEnabled(item)
                          },
                        },
                        item.enabled === false ? '启用' : '休眠',
                      ),
                      item.isHuman === true || (item.kind !== 'session' && item.kind !== 'admin')
                        ? null
                        : h(
                            'button',
                            {
                              style: S.ghost,
                              title:
                                item.kind === 'admin'
                                  ? '取消群管理：它不再负责写群史摘要'
                                  : '设为群管理：群史摘要由它用自己的模型写，再在群里用 attention_record_summary 写回',
                              onClick: function () {
                                setMemberKind(item, item.kind === 'admin' ? 'session' : 'admin')
                              },
                            },
                            item.kind === 'admin' ? '取消群管理' : '设为群管理',
                          ),
                      item.isHuman === true
                        ? null
                        : h(
                            'button',
                            {
                              style: S.danger,
                              title: confirming ? '再点一次就真的移出' : '把这个人移出群',
                              onClick: function () {
                                if (!confirming) {
                                  setPendingRemove(item.id)
                                  return
                                }
                                if (state.group === null) return
                                setPendingRemove('')
                                act({ action: 'leave', group: state.group.id, memberId: item.id })
                                  .then(again)
                                  .catch(fail)
                              },
                            },
                            confirming ? '确认移出' : '移出',
                          ),
                    ],
              ),
              h('div', { style: S.memberId }, item.locked === true ? '' : str(item.id, '')),
              h(
                'div',
                { style: S.memberRow },
                item.locked === true
                  ? null
                  : [
                      h('input', {
                        style: S.small,
                        value: draftOf(item),
                        placeholder: '订阅词：逗号分隔，例如 部署, /发布\\d+/',
                        onChange: function (event) {
                          setMemberDraft(item.id, event.target.value)
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter') saveSubscribe(item)
                        },
                      }),
                      h(
                        'button',
                        { style: S.ghost, onClick: function () { saveSubscribe(item) } },
                        '存订阅',
                      ),
                      h(
                        'select',
                        {
                          style: S.small,
                          value: typeof item.wakeEffort === 'string' ? item.wakeEffort : '',
                          title: '这个成员自己的推理强度；「跟随」= 用上面群里的统一值',
                          onChange: function (event) {
                            setKnob('member', { memberId: item.id, wakeEffort: event.target.value })
                          },
                        },
                        (Array.isArray(knobs.efforts) ? knobs.efforts : [])
                          .filter(function (option) {
                            return option !== null && typeof option === 'object'
                          })
                          .map(function (option) {
                            return h('option', { key: String(option.value), value: safeText(option.value) }, '强度 ' + safeText(option.label))
                          }),
                      ),
                    ],
              ),
              // C-16: the host has always accepted `name`; the panel had no way
              // to send it, so a member could never be renamed from here.
              item.locked === true
                ? null
                : h(
                    'div',
                    { style: S.memberRow },
                    h('input', {
                      style: Object.assign({}, S.small, { flex: '1 1 100%' }),
                      value: memberNameOf(item),
                      placeholder: '这个成员在群里的名字（@用的就是它）',
                      onChange: function (event) {
                        setMemberNameDraft(item.id, event.target.value)
                      },
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') saveMemberName(item)
                      },
                    }),
                    h('button', { style: S.ghost, onClick: function () { saveMemberName(item) } }, '改名'),
                  ),
            )
          })

          main = h(
            'div',
            { style: S.body },
            state.error ? h('div', { style: S.error }, '读取失败：' + state.error) : null,
            state.actionError ? h('div', { style: S.error }, '操作失败：' + state.actionError) : null,
            h(
              'div',
              { style: S.scroll },
              h(
                Field,
                { label: '群名称', hint: '改名不会改变群的 id，消息记录不受影响。' },
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px' } },
                  h('input', {
                    style: S.input,
                    value: titleDraft === null ? group.title : titleDraft,
                    onChange: function (event) {
                      setTitleDraft(event.target.value)
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') saveTitle()
                    },
                  }),
                  h('button', { style: S.ghost, onClick: saveTitle }, '保存'),
                ),
              ),
              h(
                Field,
                {
                  label: '唤醒',
                  value: tri(group.wakeEnabled),
                  hint:
                    '总闸。关着的时候，路由照样算、照样告诉你该叫谁，但一个 turn 都不会被启动。' +
                    '注意：这个面板里发言永远不唤醒任何人 —— 真正的唤醒来自工具调用带 wake=true。',
                },
                h(Switch, { value: group.wakeEnabled, onPick: toggleWake }),
              ),
              h(
                Field,
                {
                  label: '推理强度（群统一）',
                  value: effortLabel,
                  hint:
                    'R4b：这个群只有一个强度旋钮。叫醒成员时用的就是它；下面每个成员还能单独覆盖。' +
                    '掉线的会话不用管 —— 它们被叫醒时自然就用上了。',
                },
                h(EffortSlider, {
                  label: '推理强度（群统一）',
                  options: Array.isArray(knobs.efforts) ? knobs.efforts : [],
                  value: group.defaultEffort,
                  disabled: !effortKnown,
                  onPick: function (value) {
                    applyEffort({ effort: value })
                  },
                }),
                h(
                  'div',
                  { style: S.memberRow },
                  h(
                    'button',
                    {
                      style: S.ghost,
                      title:
                        '关着：只影响「以后被叫醒」的成员。打开：正在运行的成员也立刻改（从下一个回合开始），' +
                        '并且会顺带把本机默认使用的模型（部署默认模型）也改成这个强度。',
                      onClick: toggleLiveEffort,
                    },
                    '立刻改正在运行的成员：' + tri(group.liveEffort),
                  ),
                  h(
                    'span',
                    { style: S.fieldHint },
                    group.effortStatus === 'available'
                      ? '这个部署支持直接改正在运行的会话。'
                      : '这个部署不支持（' + str(group.effortStatus, '未报告') + '），所以这个开关只能对掉线后被叫醒的成员生效。',
                  ),
                ),
                // C-04: the side effect lived only in the tooltip. It changes the
                // DEPLOYMENT's default model, so it belongs in the visible text.
                h(
                  'div',
                  { style: S.fieldHint },
                  '说明：关着的时候，上面的滑块只对「以后被叫醒」的成员生效 —— 正在运行的成员不受影响。' +
                    '打开后，正在运行的成员也立刻改（从下一个回合开始），' +
                    '并且会顺带把本机默认使用的模型（部署默认模型）也改成这个强度，所以默认是关的。' +
                    (group.liveEffort === true ? ' 已生效：本群正在运行的成员与本机默认模型都会跟着这个旋钮走。' : ''),
                ),
                // C-05: the host reports what it actually did; silence was the bug.
                effortNote !== '' ? h('div', { style: Object.assign({}, S.fieldHint, { opacity: 0.9 }) }, effortNote) : null,
              ),
              h(
                Field,
                { label: '路由模式', value: routeLabel, hint: routeHint || '决定了什么样的消息值得叫醒谁。' },
                h(Segmented, {
                  options: Array.isArray(knobs.routeModes) ? knobs.routeModes : [],
                  value: group.routeMode,
                  onPick: function (value) {
                    setKnob('route', { routeMode: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '自省',
                  value: tri(group.selfReflect),
                  hint: '开：被叫醒的成员会先判断这条消息需不需要自己发言，不需要就只回一行，省掉一次完整回复。',
                },
                h(Switch, {
                  value: group.selfReflect,
                  onPick: function (value) {
                    setKnob('selfReflect', { selfReflect: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '未读写进系统提示',
                  value: tri(group.promptUnread),
                  hint:
                    '开：成员每次被跑起来（哪怕是因为别的事）都会在自己的系统提示里看到一行「群聊未读：…」，' +
                    '所以掉线期间的消息不会因为"没人叫醒它"而被无视。只报条数，不把消息正文塞进去；' +
                    '这是每一步都会带一行的开销，所以默认关。',
                },
                h(Switch, {
                  value: group.promptUnread,
                  onPick: function (value) {
                    setKnob('promptUnread', { promptUnread: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '唤醒时附上摘要',
                  value: tri(group.wakeSummary),
                  hint:
                    '开：被叫醒的成员收到的消息里会带这个群「最近一份摘要」（截断到 1200 字），' +
                    '这样它不必为了搞清上下文去读几十条历史；关：只发触发它的那一条。' +
                    '成员也可以自己用 attention_history 的 compact 模式，只读「摘要 + 新消息」。',
                },
                h(Switch, {
                  value: group.wakeSummary,
                  onPick: function (value) {
                    setKnob('wakeSummary', { wakeSummary: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '允许 @所有人',
                  value: tri(group.mentionAll),
                  hint:
                    '开：群里的人可以用 @所有人 一次点名全群（还是要开「唤醒」才真的叫）。' +
                    '关：这条短语只是普通文字。默认关 —— 一个每人都能叫醒全群的群，没人受得了。' +
                    '即使开了，能 @所有人 的也只有你（用户）和群管理。',
                },
                h(Switch, {
                  value: group.mentionAll,
                  onPick: function (value) {
                    setKnob('mentionAll', { mentionAll: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '群史摘要提醒',
                  value: group.summary ? countOf(group.summary.every) + ' 条' : '—（宿主未报告）',
                  hint:
                    '只提醒，不强迫：攒到设定条数还没摘要时，面板里会出现一行提醒。' +
                    '生成摘要要花一次模型调用，所以永远由你决定，插件不会自己动手。',
                },
                h(
                  'div',
                  null,
                  h(Segmented, {
                    options: (Array.isArray(knobs.summaryEveries) ? knobs.summaryEveries : []).map(function (row) {
                      return { value: String(row.value), label: row.label, hint: row.hint }
                    }),
                    value: group.summary ? String(group.summary.every) : undefined,
                    onPick: function (value) {
                      setKnob('summaryEvery', { summaryEvery: Number(value) })
                    },
                  }),
                  group.summary && group.summary.pending >= group.summary.every
                    ? h(
                        'div',
                        { style: S.notice },
                        '提醒：这个群已有 ' +
                          countOf(group.summary.pending) +
                          ' 条消息没摘要（阈值 ' +
                          countOf(group.summary.every) +
                          ' 条）。要不要摘要由你决定 —— 插件不会自己压缩，也不会删任何历史。',
                      )
                    : null,
                  h(
                    'div',
                    { style: S.memberRow },
                    h('button', { style: S.button, onClick: generateSummary }, '生成群史摘要'),
                    group.summary && group.summary.count > 0
                      ? h(
                          'div',
                          { style: S.fieldHint },
                          '已有 ' + countOf(group.summary.count) + ' 份摘要，最新覆盖到第 ' + countOf(group.summary.upToSeq) + ' 条',
                        )
                      : null,
                  ),
                  // 2026-10-21 (user request): one click, no 群管理 needed. The host
                  // calls the deployment's own model; nobody's session is woken.
                  h(
                    'div',
                    { style: S.memberRow },
                    h('button', { style: Object.assign({}, S.button, { background: '#4d6bfe' }), onClick: generateSummaryDirect }, '直接生成摘要（不叫醒任何人）'),
                    h(
                      'div',
                      { style: S.fieldHint },
                      '用部署默认模型读本群记录并写摘要，写回群记录；不叫醒任何会话，也不需要群管理。',
                    ),
                  ),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '记录占用估算：' +
                      countOf(group.stats && group.stats.messages) +
                      ' 条 · ' +
                      bigCount(group.stats && group.stats.chars) +
                      ' 字符 ≈ ' +
                      bigCount(group.stats && group.stats.estTokens) +
                      ' tokens（估算，只用于看量级，不是账单）' +
                      (group.summary ? '；未摘要 ' + countOf(group.summary.pending) + ' 条' : ''),
                  ),
                  // 2026-10-22: the summary was stored but never SHOWN. Show it.
                  h(
                    'div',
                    null,
                    h(
                      'div',
                      { style: S.fieldHint },
                      '最新一份摘要（成员被叫醒时会附上它；成员也可以调用 attention_history 的 compact 模式只读「摘要 + 之后的原文」）：',
                    ),
                    group.summary !== undefined && group.summary !== null && typeof group.summary.latestText === 'string'
                      ? h('pre', { style: S.digestBox }, group.summary.latestText)
                      : h('div', { style: S.fieldHint }, '还没有摘要正文可显示。'),
                  ),
                  h(
                    'div',
                    { style: S.fieldHint },
                    adminMembers.length > 0
                      ? '群管理（摘要由它写）：' +
                          adminMembers
                            .map(function (member) {
                              return str(member.name, '?')
                            })
                            .join('、')
                      : '这个群还没有群管理 —— 摘要必须由一个真实的 DSH 会话用自己的模型写，所以先在下面把它设上。',
                  ),
                  adminMembers.length > 0
                    ? null
                    : h(
                        'div',
                        { style: S.memberRow },
                        promoteCandidates.length === 0
                          ? h('div', { style: S.fieldHint }, '群里还没有可设为群管理的会话成员：先到「成员」里拉一个 Agent 进群。')
                          : [
                              h('span', { style: S.fieldHint }, '把谁设为群管理：'),
                            ].concat(
                              promoteCandidates.map(function (member) {
                                return h(
                                  'button',
                                  {
                                    key: 'promote-' + String(member.id),
                                    style: S.ghost,
                                    title: '设为群管理：群史摘要由它用自己的模型写，再在群里用 attention_record_summary 写回',
                                    onClick: function () {
                                      setMemberKind(member, 'admin')
                                    },
                                  },
                                  str(member.name, str(member.id, '?')),
                                )
                              }),
                            ),
                      ),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '会叫醒群管理写一次摘要（花一次模型调用，用那个会话自己的模型）。异步：点完不会立刻有结果。',
                  ),
                  summaryNote.length > 0 ? h('div', { style: S.fieldHint }, summaryNote) : null,
                ),
              ),
              h(
                Field,
                {
                  label: '群用途及群规',
                  hint:
                    '成员被叫醒时会在消息里看到这段。先写清「这个群是干什么的」，再写规矩 —— ' +
                    '一个 AI 进群后，只能靠这段知道该不该发言、说到什么程度。',
                },
                h(
                  'div',
                  null,
                  h('textarea', {
                    style: S.textarea,
                    value: charterDraft === null ? group.charter : charterDraft,
                    placeholder:
                      '这个群是干什么的：\n' +
                      '例：自由讨论群 —— 大家交流信息、可以畅所欲言；没话要说就回一行「无需参与」。\n' +
                      '或：只发通知的群 —— 这里只发结果和公告，不需要任何人回应。\n' +
                      '\n' +
                      '规矩：\n' +
                      '例：不要复述别人已经说过的内容；涉及发布流程必须 @ 群管理确认。',
                    onChange: function (event) {
                      setCharterDraft(event.target.value)
                    },
                  }),
                  h('button', { style: Object.assign({}, S.ghost, { marginTop: '6px' }), onClick: saveCharter }, '保存群用途及群规'),
                ),
              ),
              h(
                Field,
                {
                  label: '拉人权限',
                  value: '',
                  hint: 'R8：群成员（包括 Agent）默认都能拉人。这里决定谁拉得动 —— 对 Agent 生效，对你永远放行。',
                },
                h(Segmented, {
                  options: Array.isArray(knobs.joinPolicies) ? knobs.joinPolicies : [],
                  value: group.joinPolicy,
                  onPick: function (value) {
                    setKnob('joinPolicy', { joinPolicy: value })
                  },
                }),
              ),
              h(
                Field,
                {
                  label: '结论沉淀',
                  value: tri(group.sinkEnabled),
                  hint: 'R7：把结论写进一个普通 Markdown 文件。不依赖任何插件 —— 删掉本插件，文件还在。沉淀不等于发言，不会叫醒任何人。',
                },
                h(
                  'div',
                  null,
                  h(Switch, { value: group.sinkEnabled, onPick: toggleSink }),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '结论文件：' + str(group.sink && group.sink.conclusionPath, '（还没有）'),
                  ),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '已沉淀 ' +
                      countOf(group.sink && group.sink.conclusions) +
                      ' 条 · ' +
                      countOf(group.sink && group.sink.conclusionBytes) +
                      ' B · 同目录文件 ' +
                      countOf(group.sink && group.sink.files) +
                      ' 个',
                  ),
                  h(
                    'div',
                    { style: S.memberRow },
                    h('input', {
                      style: S.small,
                      value: sinkDirDraft === null ? str(group.sinkDir, '') : sinkDirDraft,
                      placeholder: '落到哪个文件夹（留空 = 插件自己的数据目录）',
                      onChange: function (event) {
                        setSinkDirDraft(event.target.value)
                      },
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') saveSinkDir()
                      },
                    }),
                    h('button', { style: S.ghost, onClick: saveSinkDir }, '存目录'),
                  ),
                  h(
                    'div',
                    { style: S.memberRow },
                    h('button', { style: S.ghost, onClick: exportNow }, '导出这个群的记录'),
                    h(
                      'button',
                      { style: S.ghost, onClick: toggleSinkMemory },
                      '同时写任务记忆：' + tri(group.sinkMemory),
                    ),
                  ),
                  exportNote.length > 0 ? h('div', { style: S.fieldHint }, exportNote) : null,
                ),
              ),
              h(
                Field,
                {
                  label: '沟通员（对外转发）',
                  value: links.length + ' 条',
                  hint: 'R10：把本群的消息定向送到另一个群。转发是【有向】的，而且转发出去的消息带着它走过的群名单 —— 任何群只要已经在名单里就会被拒绝，所以 A→B→A 不可能发生。默认只传「结论」，且默认不叫醒目标群的任何人。',
                },
                h(
                  'div',
                  null,
                  links.length === 0
                    ? h('div', { style: S.fieldHint }, '这个群还没有对外沟通员。')
                    : links.map(function (link) {
                        var row = link !== null && typeof link === 'object' ? link : {}
                        var modeLabel = str(row.mode, '?')
                        var modeOption = knobOption(knobs.relayModes, row.mode)
                        if (modeOption !== null) modeLabel = str(modeOption.label, modeLabel)
                        // C-02b: `keywords` may be a STRING in a ledger written by
                        // the old panel. `(value || []).join` threw here, which in
                        // real React is a blank page.
                        var keywordTags = keywordsText(row.keywords)
                        return h(
                          'div',
                          { key: String(row.id === undefined ? row.to : row.id), style: S.member },
                          h(
                            'div',
                            { style: S.memberTop },
                            h('span', { style: S.memberName }, '→ ' + str(row.to, '?')),
                            h('span', { style: S.tag }, modeLabel),
                            h('span', { style: S.tag }, row.wake === true ? '会叫醒目标群' : '只记录'),
                            keywordTags.length > 0 ? h('span', { style: S.tag }, keywordTags) : null,
                            h(
                              'button',
                              {
                                style: S.ghost,
                                title: row.enabled === false ? '重新启用这条沟通员' : '暂时关掉这条沟通员（不删除）',
                                onClick: function () {
                                  patchLink(row.to, { enabled: row.enabled === false })
                                },
                              },
                              row.enabled === false ? '启用' : '停用',
                            ),
                            h(
                              'button',
                              {
                                style: S.ghost,
                                title: '让目标群里被命中的成员真的被叫醒（目标群的唤醒开关也要是开的）',
                                onClick: function () {
                                  patchLink(row.to, { wake: row.wake !== true })
                                },
                              },
                              row.wake === true ? '改为只记录' : '改为叫醒',
                            ),
                            h(
                              'button',
                              {
                                style: S.danger,
                                onClick: function () {
                                  dropLink(row.to)
                                },
                              },
                              '移除',
                            ),
                          ),
                          // C-16: the host has always accepted maxHops; the panel
                          // had no control for it.
                          h(
                            'div',
                            { style: S.memberRow },
                            h('input', {
                              style: Object.assign({}, S.small, { flex: '0 0 90px' }),
                              type: 'number',
                              min: 1,
                              value: hopOf(row),
                              placeholder: '跳数上限',
                              title: '转发最多还能穿过几个群。宿主会把它夹在自己的允许范围内，存完这里显示的是宿主实际存下的值。',
                              onChange: function (event) {
                                setHopDraft(row.to, event.target.value)
                              },
                              onKeyDown: function (event) {
                                if (event.key === 'Enter') saveHops(row)
                              },
                            }),
                            h('button', { style: S.ghost, onClick: function () { saveHops(row) } }, '存跳数'),
                            h(
                              'span',
                              { style: S.fieldHint },
                              '当前：' + (countKnown(row.maxHops) ? String(row.maxHops) : '宿主未报告'),
                            ),
                          ),
                        )
                      }),
                  h(
                    'div',
                    { style: S.memberRow },
                    h(
                      'select',
                      {
                        style: S.small,
                        value: linkTarget,
                        onChange: function (event) {
                          setLinkTarget(event.target.value)
                        },
                      },
                      [h('option', { key: '', value: '' }, '选一个目标群…')].concat(
                        (Array.isArray(state.linkTargets) ? state.linkTargets : [])
                          .filter(function (row) {
                            if (row === null || typeof row !== 'object') return false
                            return state.group === null || row.id !== state.group.id
                          })
                          .map(function (row) {
                            return h('option', { key: String(row.id), value: safeText(row.id) }, str(row.title, safeText(row.id)))
                          }),
                      ),
                    ),
                  ),
                  h(Segmented, {
                    options: Array.isArray(knobs.relayModes) ? knobs.relayModes : [],
                    value: linkMode,
                    onPick: setLinkMode,
                  }),
                  h(
                    'div',
                    { style: S.memberRow },
                    h('input', {
                      style: S.small,
                      value: linkKeywords,
                      placeholder: '关键词或要盯的名字（逗号分隔；按结论模式时留空即可）',
                      onChange: function (event) {
                        setLinkKeywords(event.target.value)
                      },
                      onKeyDown: function (event) {
                        if (event.key === 'Enter') saveLink()
                      },
                    }),
                    h(
                      'button',
                      {
                        style: S.ghost,
                        title: '转发时是否也叫醒目标群里被命中的成员',
                        onClick: function () {
                          setLinkWake(!linkWake)
                        },
                      },
                      linkWake ? '会叫醒' : '只记录',
                    ),
                    h('button', { style: S.button, onClick: saveLink }, '建立/更新'),
                  ),
                  // C-11: the click that used to send nothing and say nothing.
                  linkNote !== '' ? h('div', { style: Object.assign({}, S.fieldHint, { opacity: 1 }) }, linkNote) : null,
                ),
              ),
              h(
                Field,
                {
                  label: '成员（' + group.members.length + '）',
                  hint: '「休眠」= 不再被叫醒也不占额度；「跟随」的强度用上面那个统一值；订阅词命中就会叫醒这个人。',
                },
                h(
                  'div',
                  null,
                  memberRows,
                  adding
                    ? h(
                        'div',
                        null,
                        h(
                          'div',
                          { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' } },
                          h('input', {
                            style: S.input,
                            value: newMemberId,
                            // The whole request (2026-10-17): no more copying session
                            // ids. Focusing the box opens the list of sessions with
                            // their titles; typing narrows it.
                            placeholder: '点这个框选一个会话，或直接粘贴会话 id',
                            onFocus: openCandidates,
                            onChange: function (event) {
                              setNewMemberId(event.target.value)
                              openCandidates()
                            },
                            onKeyDown: function (event) {
                              if (event.key === 'Enter') addMember()
                              if (event.key === 'Escape') closeCandidates()
                            },
                          }),
                          h(
                            'button',
                            {
                              style: S.ghost,
                              title: '列出最近用过的会话：标题、工作区、最后活动时间',
                              onClick: openCandidates,
                            },
                            '选会话',
                          ),
                          h('input', {
                            style: Object.assign({}, S.input, { flex: '0 0 130px' }),
                            value: newMemberName,
                            placeholder: '@用的名字',
                            onChange: function (event) {
                              setNewMemberName(event.target.value)
                            },
                          }),
                          h(
                            'select',
                            {
                              style: S.small,
                              value: newMemberKind,
                              onChange: function (event) {
                                setNewMemberKind(event.target.value)
                              },
                            },
                            (Array.isArray(knobs.memberKinds) ? knobs.memberKinds : []).map(function (kind) {
                              return h('option', { key: kind, value: kind }, str(MENTION_KIND_TEXT[kind], kind))
                            }),
                          ),
                          h('button', { style: S.button, onClick: addMember }, '拉进来'),
                          h('button', { style: S.ghost, onClick: function () { setAdding(false) } }, '取消'),
                        ),
                        candidatePanel(),
                        h(
                          'div',
                          { style: S.fieldHint },
                          '选中一个会话会自动填上它的标题当名字，可以改；两个人同名时，@ 名字会同时叫醒两个人。',
                        ),
                      )
                    : h(
                        'button',
                        { style: Object.assign({}, S.ghost, { marginTop: '4px' }), onClick: function () { setAdding(true) } },
                        '＋ 拉人进群',
                      ),
                ),
              ),
              h(
                Field,
                { label: '这个群的记录在哪', hint: '每个群的消息都独立落盘，不进任何人的会话上下文。群与群之间互不可见。' },
                h('div', { style: { fontSize: '11px', opacity: 0.6, wordBreak: 'break-all' } }, group.id),
              ),
            ),
          )
        }

        body = h('div', { style: S.body }, head, tabs, main)
      }

      return h('div', { style: S.wrap }, list, body)
    }

    var exports = {}
    exports.inject = ['slots']
    // Test seam: pure helpers only (no state, no host access). The module loader
    // reads `inject` and `apply` and ignores anything else, so this keeps the
    // scroll policy directly unit-testable instead of hoping a browser checks it.
    exports.__test = { maxSeqOf: maxSeqOf, nearBottom: nearBottom, planScroll: planScroll }
    exports.apply = function (ctx) {
      // The sidebar button. Its id addresses the main panel below, so the two
      // must agree; a fresh id adds an entry rather than replacing a shipped one.
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          { name: 'sidebar.panellist', id: 'attention-group', order: 40, label: function () { return '群聊' } },
          PanelGlyph,
        )
      })
      // The panel body the sidebar button opens.
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'attention-group' }, GroupPanel)
      })
    }
    return exports
  },
})
