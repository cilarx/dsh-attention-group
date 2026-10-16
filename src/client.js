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

    /** Ask the host for the room list, plus one room's transcript and knobs. */
    function load(groupId) {
      var query = groupId === undefined || groupId === null ? '' : '?group=' + encodeURIComponent(groupId)
      return fetch(API + query, { cache: 'no-store' }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok !== true) throw new Error(data.error || 'HTTP ' + response.status)
          return data
        })
      })
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
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok || data.ok !== true) throw new Error(data.error || 'HTTP ' + response.status)
          return data
        })
      })
    }

    /** A display string that can never be the literal word "undefined". */
    function str(value, fallback) {
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return fallback === undefined ? '' : fallback
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
      if (!Array.isArray(detail.members)) return detail
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

    var S = {
      wrap: { display: 'flex', height: '100%', minHeight: 0, fontSize: '13px' },
      list: {
        width: '230px',
        flex: '0 0 230px',
        borderRight: '1px solid var(--dsh-border, rgba(127,127,127,.22))',
        overflowY: 'auto',
        padding: '8px',
        boxSizing: 'border-box',
      },
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
      listItemActive: { background: 'var(--dsh-surface-2, rgba(127,127,127,.16))' },
      itemTop: { display: 'flex', alignItems: 'center', gap: '6px' },
      itemTitle: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      itemMeta: { fontSize: '11px', opacity: 0.6, marginTop: '2px' },
      badge: {
        display: 'inline-block',
        minWidth: '18px',
        padding: '0 5px',
        borderRadius: '9px',
        background: 'var(--dsh-accent, #4d6bfe)',
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
        borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.22))',
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
        background: 'var(--dsh-surface-2, rgba(127,127,127,.14))',
        borderColor: 'var(--dsh-border, rgba(127,127,127,.25))',
        borderBottomColor: 'transparent',
      },
      scroll: { flex: '1 1 auto', overflowY: 'auto', padding: '10px 14px', minHeight: 0 },
      row: { marginBottom: '10px' },
      meta: { fontSize: '11px', opacity: 0.65, marginBottom: '2px' },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      composer: {
        display: 'flex',
        gap: '8px',
        padding: '10px 14px',
        borderTop: '1px solid var(--dsh-border, rgba(127,127,127,.22))',
      },
      input: {
        flex: '1 1 auto',
        minWidth: 0,
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
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
        border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        resize: 'vertical',
      },
      button: {
        padding: '7px 14px',
        borderRadius: '8px',
        border: 0,
        background: 'var(--dsh-accent, #4d6bfe)',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
      },
      ghost: {
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.32))',
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
        color: '#E24B4A',
        cursor: 'pointer',
        font: 'inherit',
        flex: '0 0 auto',
        fontSize: '12px',
      },
      hint: { padding: '16px', opacity: 0.7, lineHeight: 1.6 },
      error: { padding: '8px 14px', color: '#E24B4A', fontSize: '12px', lineHeight: 1.5, wordBreak: 'break-word' },
      charter: {
        margin: '0 0 10px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsh-surface-2, rgba(127,127,127,.12))',
        fontSize: '12px',
        opacity: 0.85,
        whiteSpace: 'pre-wrap',
      },
      field: { padding: '10px 14px', borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.14))' },
      fieldHead: { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '4px' },
      fieldLabel: { fontWeight: 600 },
      fieldValue: { fontSize: '11px', opacity: 0.6 },
      fieldHint: { fontSize: '11px', opacity: 0.6, lineHeight: 1.5, marginTop: '4px' },
      segmented: { display: 'flex', flexWrap: 'wrap', gap: '4px' },
      segment: {
        padding: '4px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
      },
      segmentActive: { background: 'var(--dsh-accent, #4d6bfe)', color: '#fff', borderColor: 'transparent' },
      slider: { width: '100%', accentColor: 'var(--dsh-accent, #4d6bfe)' },
      scale: { display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.55 },
      scaleOn: { opacity: 1, fontWeight: 700 },
      scaleOff: {},
      member: {
        padding: '8px 10px',
        marginBottom: '6px',
        borderRadius: '8px',
        background: 'var(--dsh-surface-2, rgba(127,127,127,.1))',
      },
      memberTop: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      memberName: { fontWeight: 600, flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      tag: {
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
        opacity: 0.7,
      },
      memberId: { fontSize: '10px', opacity: 0.45, wordBreak: 'break-all', marginTop: '2px' },
      memberRow: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' },
      small: { flex: '1 1 auto', minWidth: 0, padding: '4px 8px', borderRadius: '6px', border: '1px solid var(--dsh-border, rgba(127,127,127,.28))', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px' },
      digestBar: {
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px',
        padding: '8px 14px 0',
        borderTop: '1px solid var(--dsh-border, rgba(127,127,127,.14))',
      },
      digestBox: {
        margin: '8px 14px 0',
        padding: '8px 10px',
        maxHeight: '180px',
        overflowY: 'auto',
        borderRadius: '8px',
        background: 'var(--dsh-surface-2, rgba(127,127,127,.12))',
        fontSize: '11px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
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
      var options = props.options || []
      return h(
        'div',
        { style: S.segmented },
        options.map(function (option) {
          var active = option.value === props.value
          return h(
            'button',
            {
              key: option.value,
              title: option.hint || '',
              style: Object.assign({}, S.segment, active ? S.segmentActive : {}),
              onClick: function () {
                props.onPick(option.value)
              },
            },
            option.label,
          )
        }),
      )
    }

    /** A switch. Rendered as a button so its on/off state is in its own text. */
    function Switch(props) {
      var on = props.value === true
      return h(
        'button',
        {
          title: props.hint || '',
          style: Object.assign({}, on ? S.button : S.ghost, { fontSize: '12px', padding: '5px 12px' }),
          onClick: function () {
            props.onPick(!on)
          },
        },
        on ? '开' : '关',
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
      var options = props.options || []
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
          onChange: function (event) {
            var picked = options[Number(event.target.value)]
            if (picked !== undefined) props.onPick(picked.value)
          },
        }),
        h(
          'div',
          { style: S.scale },
          options.map(function (option) {
            return h('span', { key: option.value, style: option.value === props.value ? S.scaleOn : S.scaleOff }, option.label)
          }),
        ),
        h('div', { style: S.fieldHint }, current.hint),
      )
    }

    /** The panel body. */
    function GroupPanel() {
      var [state, setState] = useState({
        loading: true,
        error: '',
        groups: [],
        group: null,
        messages: [],
        knobs: { routeModes: [], efforts: [], joinPolicies: [], memberKinds: [], relayModes: [] },
        linkTargets: [],
      })
      var [draft, setDraft] = useState('')
      var [chosen, setChosen] = useState(null)
      var [tab, setTab] = useState('chat')
      var [creating, setCreating] = useState(false)
      var [newRoomTitle, setNewRoomTitle] = useState('')
      var [titleDraft, setTitleDraft] = useState(null)
      var [charterDraft, setCharterDraft] = useState(null)
      var [memberDrafts, setMemberDrafts] = useState({})
      var [adding, setAdding] = useState(false)
      var [newMemberId, setNewMemberId] = useState('')
      var [newMemberName, setNewMemberName] = useState('')
      var [newMemberKind, setNewMemberKind] = useState('session')
      var [pendingRemove, setPendingRemove] = useState('')
      var [sinkDirDraft, setSinkDirDraft] = useState(null)
      var [exportNote, setExportNote] = useState('')
      var [digestText, setDigestText] = useState('')
      var [linkTarget, setLinkTarget] = useState('')
      var [linkMode, setLinkMode] = useState('conclusion')
      var [linkKeywords, setLinkKeywords] = useState('')
      var [linkWake, setLinkWake] = useState(false)
      var logRef = useRef(null)

      function refresh(groupId) {
        var wanted = groupId === undefined ? chosen : groupId
        return load(wanted === null ? undefined : wanted)
          .then(function (data) {
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
            setState({
              loading: false,
              error: '',
              groups: data.groups || [],
              group: detail,
              messages: rows === null ? [] : rows,
              knobs: data.knobs || { routeModes: [], efforts: [], joinPolicies: [], memberKinds: [], relayModes: [] },
              linkTargets: data.linkTargets || [],
            })
          })
          .catch(function (error) {
            // Keep whatever was already on screen: a transient failure must not
            // also erase the room the user is reading.
            setState(function (prev) {
              return Object.assign({}, prev, { loading: false, error: String(error.message || error) })
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
          if (node) node.scrollTop = node.scrollHeight
        },
        [state.messages],
      )

      function fail(error) {
        setState(function (prev) {
          return Object.assign({}, prev, { error: String(error.message || error) })
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
        // Opening a room is what "reading" it means. A failure here costs an
        // unread count, not the read — so it is not worth an error banner.
        act({ action: 'read', group: id }).catch(function () {})
      }

      function submit() {
        var text = draft.trim()
        if (text.length === 0 || state.group === null) return
        setDraft('')
        act({ action: 'post', group: state.group.id, text: text })
          .then(again)
          .catch(fail)
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

      function setKnob(action, payload, label) {
        if (state.group === null) return
        act(Object.assign({ action: action, group: state.group.id }, payload))
          .then(again)
          .catch(fail)
      }

      function toggleWake() {
        if (state.group === null) return
        setKnob('wake', { wakeEnabled: !state.group.wakeEnabled })
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

      /** U3: let the room's effort knob reach sessions that are alive right now. */
      function toggleLiveEffort() {
        if (state.group === null) return
        act({ action: 'effort', group: state.group.id, liveEffort: state.group.liveEffort !== true })
          .then(again)
          .catch(fail)
      }

      /** R10: liaisons out of this room. Directed, switchable, and loop-proof. */
      function saveLink() {
        if (state.group === null || linkTarget.length === 0) return
        act({
          action: 'link',
          group: state.group.id,
          to: linkTarget,
          mode: linkMode,
          keywords: linkKeywords,
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
        if (state.group === null) return
        act(Object.assign({ action: 'link', group: state.group.id, to: to }, patch))
          .then(again)
          .catch(fail)
      }

      function dropLink(to) {
        if (state.group === null) return
        act({ action: 'unlink', group: state.group.id, to: to })
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
        act({ action: 'sink', group: state.group.id, sinkEnabled: state.group.sinkEnabled !== true })
          .then(again)
          .catch(fail)
      }

      function toggleSinkMemory() {
        if (state.group === null) return
        act({ action: 'sink', group: state.group.id, sinkMemory: state.group.sinkMemory !== true })
          .then(again)
          .catch(fail)
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
            setExportNote('已写入 ' + str(data.path, '(未报告路径)') + '（' + str(data.messages, '0') + ' 条）')
            return again()
          })
          .catch(function (error) {
            setExportNote('')
            fail(error)
          })
      }

      function draftOf(member) {        if (Object.prototype.hasOwnProperty.call(memberDrafts, member.id)) return memberDrafts[member.id]
        return (member.subscribe || []).join(', ')
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
        act({ action: 'member', group: state.group.id, memberId: member.id, subscribe: draftOf(member) })
          .then(function () {
            dropMemberDraft(member.id)
            return again()
          })
          .catch(fail)
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
            setAdding(false)
            return again()
          })
          .catch(fail)
      }

      if (state.loading) return h('div', { style: S.hint }, '正在读取群聊…')

      var groups = state.groups
      var knobs = state.knobs
      var totalMessages = groups.reduce(function (sum, row) {
        return sum + (typeof row.messages === 'number' ? row.messages : 0)
      }, 0)
      var totalUnread = groups.reduce(function (sum, row) {
        return sum + (typeof row.unread === 'number' ? row.unread : 0)
      }, 0)

      var list = h(
        'div',
        { style: S.list },
        // A failed read must never look like an empty room. A 404 panel reading
        // as "you have no groups yet" is exactly what cost two debugging rounds
        // on 2026-10-16, so the failure is stated where the list would be.
        state.error
          ? h('div', { style: Object.assign({}, S.error, { padding: '4px 8px 8px', fontSize: '11px' }) }, '读取失败：' + state.error)
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px 8px' } },
          h(
            'span',
            { style: { flex: '1 1 auto', opacity: 0.6, fontSize: '11px' } },
            groups.length + ' 个群 · ' + totalMessages + ' 条' + (totalUnread > 0 ? ' · 未读 ' + totalUnread : ''),
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
            // SUCCEEDED. On a failure the error above is the whole story, and
            // adding "还没有群" here is exactly the lie that cost two debugging
            // rounds on 2026-10-16.
            state.error
            ? null
            : h('div', { style: { padding: '8px 10px', opacity: 0.65 } }, '还没有群。点上面的 ＋ 建一个。')
          : groups.map(function (row) {
              var active = state.group !== null && state.group.id === row.id
              var unread = typeof row.unread === 'number' ? row.unread : 0
              return h(
                'button',
                {
                  key: row.id,
                  style: Object.assign({}, S.listItem, active ? S.listItemActive : {}),
                  onClick: function () {
                    openRoom(row.id)
                  },
                },
                h(
                  'div',
                  { style: S.itemTop },
                  h('span', { style: S.itemTitle }, str(row.title, row.id)),
                  unread > 0 ? h('span', { style: S.badge }, String(unread)) : null,
                ),
                h(
                  'div',
                  { style: S.itemMeta },
                  str(row.memberCount, '0') + ' 人 · ' + str(row.messages, '0') + ' 条' + (row.wakeEnabled === true ? ' · 唤醒开' : ''),
                ),
                row.lastPreview ? h('div', { style: S.itemMeta }, str(row.lastFrom, '?') + '：' + row.lastPreview) : null,
              )
            }),
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
        var routeLabel = ''
        var routeHint = ''
        ;(knobs.routeModes || []).forEach(function (option) {
          if (option.value === group.routeMode) {
            routeLabel = option.label
            routeHint = option.hint
          }
        })
        var effortLabel = ''
        ;(knobs.efforts || []).forEach(function (option) {
          if (option.value === group.defaultEffort) effortLabel = option.label
        })

        var head = h(
          'div',
          { style: S.head },
          h(
            'div',
            { style: { flex: '1 1 auto', minWidth: 0 } },
            h('div', { style: S.headTitle }, str(group.title, group.id)),
            h(
              'div',
              { style: S.headMeta },
              group.members.length +
                ' 人 · ' +
                str(group.messageCount, '0') +
                ' 条 · 路由 ' +
                str(routeLabel, group.routeMode) +
                ' · 强度 ' +
                str(effortLabel, '跟随'),
            ),
          ),
          h(
            'button',
            {
              style: Object.assign({}, group.wakeEnabled === true ? S.button : S.ghost, { padding: '3px 10px', fontSize: '12px' }),
              title:
                group.wakeEnabled === true
                  ? '唤醒已开：被 @ 或命中订阅词的成员会被真的叫起来跑一轮'
                  : '唤醒已关：消息只进群记录，不打扰任何人的会话',
              onClick: toggleWake,
            },
            group.wakeEnabled === true ? '唤醒 开' : '唤醒 关',
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
            state.error ? h('div', { style: S.error }, '操作失败：' + state.error) : null,
            h(
              'div',
              { style: S.scroll, ref: logRef },
              state.messages.length === 0
                ? h('div', { style: { opacity: 0.6 } }, '这个群还没有消息。')
                : state.messages.map(function (row) {
                    return h(
                      'div',
                      { key: String(row.seq), style: S.row },
                      h('div', { style: S.meta }, '#' + str(row.seq, '?') + '  ' + stampOf(row.at) + '  ' + str(row.fromName, '?')),
                      h('div', { style: S.text }, str(row.text, '')),
                    )
                  }),
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
            h(
              'div',
              { style: S.composer },
              h('input', {
                style: S.input,
                value: draft,
                placeholder: '以「用户」身份发言（@名字 可点名）',
                onChange: function (event) {
                  setDraft(event.target.value)
                },
                onKeyDown: function (event) {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                },
              }),
              h('button', { style: S.button, onClick: submit }, '发送'),
            ),
          )
        } else {
          var memberRows = group.members.map(function (member) {
            var confirming = pendingRemove === member.id
            return h(
              'div',
              { key: member.id, style: S.member },
              h(
                'div',
                { style: S.memberTop },
                h('span', { style: S.memberName }, str(member.name, member.id)),
                h('span', { style: S.tag }, str(member.kind, 'session')),
                h('span', { style: S.tag }, member.wakeable === true ? '可唤醒' : '只记录'),
                member.enabled === false ? h('span', { style: S.tag }, '已休眠') : null,
                // A row with no member id (the pre-restart shape) gets no controls:
                // a write with a guessed id is a write the host must refuse.
                member.locked === true
                  ? h('span', { style: S.tag }, '重启 DSH 后可管理')
                  : [
                      h(
                        'button',
                        {
                          style: S.ghost,
                          title: member.enabled === false ? '重新启用：它可以被叫醒了' : '休眠：这个成员不再被叫醒，也不占额度',
                          onClick: function () {
                            if (state.group === null) return
                            act({ action: 'member', group: state.group.id, memberId: member.id, enabled: member.enabled === false })
                              .then(again)
                              .catch(fail)
                          },
                        },
                        member.enabled === false ? '启用' : '休眠',
                      ),
                      member.isHuman === true
                        ? null
                        : h(
                            'button',
                            {
                              style: S.danger,
                              title: confirming ? '再点一次就真的移出' : '把这个人移出群',
                              onClick: function () {
                                if (!confirming) {
                                  setPendingRemove(member.id)
                                  return
                                }
                                if (state.group === null) return
                                setPendingRemove('')
                                act({ action: 'leave', group: state.group.id, memberId: member.id })
                                  .then(again)
                                  .catch(fail)
                              },
                            },
                            confirming ? '确认移出' : '移出',
                          ),
                    ],
              ),
              h('div', { style: S.memberId }, member.locked === true ? '' : member.id),
              h(
                'div',
                { style: S.memberRow },
                member.locked === true
                  ? null
                  : [
                      h('input', {
                        style: S.small,
                        value: draftOf(member),
                        placeholder: '订阅词：逗号分隔，例如 部署, /发布\\d+/',
                        onChange: function (event) {
                          setMemberDraft(member.id, event.target.value)
                        },
                        onKeyDown: function (event) {
                          if (event.key === 'Enter') saveSubscribe(member)
                        },
                      }),
                      h(
                        'button',
                        { style: S.ghost, onClick: function () { saveSubscribe(member) } },
                        '存订阅',
                      ),
                      h(
                        'select',
                        {
                          style: S.small,
                          value: member.wakeEffort,
                          title: '这个成员自己的推理强度；「跟随」= 用上面群里的统一值',
                          onChange: function (event) {
                            if (state.group === null) return
                            act({
                              action: 'member',
                              group: state.group.id,
                              memberId: member.id,
                              wakeEffort: event.target.value,
                            })
                              .then(again)
                              .catch(fail)
                          },
                        },
                        (knobs.efforts || []).map(function (option) {
                          return h('option', { key: option.value, value: option.value }, '强度 ' + option.label)
                        }),
                      ),
                    ],
              ),
            )
          })

          main = h(
            'div',
            { style: S.body },
            state.error ? h('div', { style: S.error }, '操作失败：' + state.error) : null,
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
                  value: group.wakeEnabled === true ? '开' : '关',
                  hint: '总闸。关着的时候，路由照样算、照样告诉你该叫谁，但一个 turn 都不会被启动。',
                },
                h(Switch, { value: group.wakeEnabled === true, onPick: toggleWake }),
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
                  options: knobs.efforts || [],
                  value: group.defaultEffort,
                  onPick: function (value) {
                    setKnob('effort', { effort: value })
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
                        '打开后，上面的滑块会立刻改这个群里正在活着的会话（下一个 step 生效）。' +
                        '注意：这个调用会顺带把「部署默认模型」也改成同样的选择 —— 所以默认是关的。',
                      onClick: toggleLiveEffort,
                    },
                    '也改活会话：' + (group.liveEffort === true ? '开' : '关'),
                  ),
                  h(
                    'span',
                    { style: S.fieldHint },
                    group.effortStatus === 'available'
                      ? '这个部署支持改活会话。'
                      : '这个部署没有 sessionController（' + str(group.effortStatus, '未知') + '），所以只能影响掉线后被叫醒的会话。',
                  ),
                ),
              ),
              h(
                Field,
                { label: '路由模式', value: routeLabel, hint: routeHint || '决定了什么样的消息值得叫醒谁。' },
                h(Segmented, {
                  options: knobs.routeModes || [],
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
                  value: group.selfReflect === true ? '开' : '关',
                  hint: '开：被叫醒的成员会先判断这条消息需不需要自己发言，不需要就只回一行，省掉一次完整回复。',
                },
                h(Switch, {
                  value: group.selfReflect === true,
                  onPick: function (value) {
                    setKnob('selfReflect', { selfReflect: value })
                  },
                }),
              ),
              h(
                Field,
                { label: '群规', hint: '成员被叫醒时会在消息里看到这段。写「什么该说、什么不该说」比写「要友好」有用。' },
                h(
                  'div',
                  null,
                  h('textarea', {
                    style: S.textarea,
                    value: charterDraft === null ? group.charter : charterDraft,
                    placeholder: '例如：只在被 @ 或涉及发布流程时发言；不需要发言就回一行「无需参与」。',
                    onChange: function (event) {
                      setCharterDraft(event.target.value)
                    },
                  }),
                  h('button', { style: Object.assign({}, S.ghost, { marginTop: '6px' }), onClick: saveCharter }, '保存群规'),
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
                  options: knobs.joinPolicies || [],
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
                  value: group.sinkEnabled === true ? '开' : '关',
                  hint: 'R7：把结论写进一个普通 Markdown 文件。不依赖任何插件 —— 删掉本插件，文件还在。沉淀不等于发言，不会叫醒任何人。',
                },
                h(
                  'div',
                  null,
                  h(Switch, { value: group.sinkEnabled === true, onPick: toggleSink }),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '结论文件：' + str(group.sink && group.sink.conclusionPath, '（还没有）'),
                  ),
                  h(
                    'div',
                    { style: S.fieldHint },
                    '已沉淀 ' +
                      str(group.sink && group.sink.conclusions, '0') +
                      ' 条 · ' +
                      str(group.sink && group.sink.conclusionBytes, '0') +
                      ' B · 同目录文件 ' +
                      str(group.sink && group.sink.files, '0') +
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
                      '同时写任务记忆：' + (group.sinkMemory === true ? '开' : '关'),
                    ),
                  ),
                  exportNote.length > 0 ? h('div', { style: S.fieldHint }, exportNote) : null,
                ),
              ),
              h(
                Field,
                {
                  label: '沟通员（对外转发）',
                  value: (group.links || []).length + ' 条',
                  hint: 'R10：把本群的消息定向送到另一个群。转发是【有向】的，而且转发出去的消息带着它走过的群名单 —— 任何群只要已经在名单里就会被拒绝，所以 A→B→A 不可能发生。默认只传「结论」，且默认不叫醒目标群的任何人。',
                },
                h(
                  'div',
                  null,
                  (group.links || []).length === 0
                    ? h('div', { style: S.fieldHint }, '这个群还没有对外沟通员。')
                    : (group.links || []).map(function (link) {
                        var modeLabel = link.mode
                        ;(knobs.relayModes || []).forEach(function (option) {
                          if (option.value === link.mode) modeLabel = option.label
                        })
                        return h(
                          'div',
                          { key: link.id || link.to, style: S.member },
                          h(
                            'div',
                            { style: S.memberTop },
                            h('span', { style: S.memberName }, '→ ' + str(link.to, '?')),
                            h('span', { style: S.tag }, str(modeLabel, link.mode)),
                            h('span', { style: S.tag }, link.wake === true ? '会叫醒目标群' : '只记录'),
                            (link.keywords || []).length > 0 ? h('span', { style: S.tag }, (link.keywords || []).join(' / ')) : null,
                            h(
                              'button',
                              {
                                style: S.ghost,
                                title: link.enabled === false ? '重新启用这条沟通员' : '暂时关掉这条沟通员（不删除）',
                                onClick: function () {
                                  patchLink(link.to, { enabled: link.enabled === false })
                                },
                              },
                              link.enabled === false ? '启用' : '停用',
                            ),
                            h(
                              'button',
                              {
                                style: S.ghost,
                                title: '让目标群里被命中的成员真的被叫醒（目标群的唤醒开关也要是开的）',
                                onClick: function () {
                                  patchLink(link.to, { wake: link.wake !== true })
                                },
                              },
                              link.wake === true ? '改为只记录' : '改为叫醒',
                            ),
                            h(
                              'button',
                              {
                                style: S.danger,
                                onClick: function () {
                                  dropLink(link.to)
                                },
                              },
                              '移除',
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
                        (state.linkTargets || [])
                          .filter(function (row) {
                            return state.group === null || row.id !== state.group.id
                          })
                          .map(function (row) {
                            return h('option', { key: row.id, value: row.id }, str(row.title, row.id))
                          }),
                      ),
                    ),
                  ),
                  h(Segmented, {
                    options: knobs.relayModes || [],
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
                        { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' } },
                        h('input', {
                          style: S.input,
                          value: newMemberId,
                          placeholder: '会话 id，或 user / admin / bot 这类稳定 id',
                          onChange: function (event) {
                            setNewMemberId(event.target.value)
                          },
                          onKeyDown: function (event) {
                            if (event.key === 'Enter') addMember()
                          },
                        }),
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
                          (knobs.memberKinds || []).map(function (kind) {
                            return h('option', { key: kind, value: kind }, kind)
                          }),
                        ),
                        h('button', { style: S.button, onClick: addMember }, '拉进来'),
                        h('button', { style: S.ghost, onClick: function () { setAdding(false) } }, '取消'),
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
