// the clip popup: saves the current tab to Mogul as a note on the signed-in mogul.
//
// it talks to the gateway exactly as the studio does: the gateway's session cookie rides
// along on every request (credentials: 'include'), and the gateway relays the user's
// token to the api. so being signed in to the studio in this browser is all it takes.

// the mogul to talk to is the one host the manifest grants access to: the local stack in
// the repo's manifest.json, production in the build bin/package.sh makes for the store.
// so there's nothing to configure, and nothing to choose
function serverFromManifest() {
    const hosts = chrome.runtime.getManifest().host_permissions || []
    if (hosts.length !== 1)
        throw new Error(`manifest.json should grant exactly one host, not ${hosts.length}.`)
    return new URL(hosts[0].replace(/\*$/, '')).origin
}

const $ = (id) => document.getElementById(id)

const state = {
    server: null, // { url }: the gateway, from the manifest
    mogul: null, // { id, givenName }
    tab: null, // the tab the popup was opened on
    existing: null, // the note already clipped for this page, if any: { id, title, note, url, type, notableId }
    // what the note goes on. 'global' is the mogul itself, the default. each of the
    // others remembers its own picks, so flipping between them loses nothing; only the
    // chosen kind's picks count. childId 'parent' means the podcast itself
    attach: {kind: 'global', picks: {podcasts: {}, blogs: {}}},
    lists: new Map(), // the podcasts, episodes, blogs, and posts loaded so far
}

// what each kind of attachment lists, and what it attaches the note to
const ATTACH = {
    podcasts: {
        parentLabel: 'Podcast', childLabel: 'Episode',
        chooseParent: 'Choose a podcast', chooseChild: 'Choose an episode',
        noParents: 'You have no podcasts yet', noChildren: 'This podcast has no episodes yet',
        parentType: 'podcast', wholeParent: 'The whole podcast', childType: 'episode',
        parents: async () => (await graphql('query { podcasts { id title } }')).podcasts,
        children: async (podcastId) => (await graphql(`
            query ($id: Int) { podcastEpisodesByPodcast(podcastId: $id) { id title created } }`,
            {id: podcastId})).podcastEpisodesByPodcast,
        parentOf: async (episodeId) => (await graphql(`
            query ($id: Int) { podcastEpisodeById(podcastEpisodeId: $id) { podcastId } }`,
            {id: episodeId})).podcastEpisodeById.podcastId,
    },
    blogs: {
        parentLabel: 'Blog', childLabel: 'Post',
        chooseParent: 'Choose a blog', chooseChild: 'Choose a post',
        noParents: 'You have no blogs yet', noChildren: 'This blog has no posts yet',
        parentType: null, childType: 'post', // a blog itself can't have notes, only its posts
        parents: async () => (await graphql('query { blogs { id title } }')).blogs,
        children: async (blogId) => (await graphql(`
            query ($id: Int) { blogPostsByBlog(blogId: $id) { id title created } }`,
            {id: blogId})).blogPostsByBlog,
        parentOf: async (postId) => (await graphql(`
            query ($id: Int) { postById(postId: $id) { blogId } }`,
            {id: postId})).postById.blogId,
    },
}

class SignedOutError extends Error {
}

async function graphql(query, variables = {}) {
    let response
    try {
        response = await fetch(state.server.url + '/api/graphql', {
            method: 'POST',
            credentials: 'include',
            // a signed-out request is answered with a redirect to the login page.
            // don't follow it: a redirect here just means "not signed in"
            redirect: 'manual',
            headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
            body: JSON.stringify({query, variables}),
        })
    } catch (e) {
        throw new Error(`Couldn't reach ${state.server.url}. Is it running?`)
    }
    if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403)
        throw new SignedOutError()
    if (!response.ok)
        throw new Error(`${state.server.url} answered ${response.status}.`)
    const body = await response.json()
    if (body.errors && body.errors.length)
        throw new Error(body.errors.map(e => e.message).join('; '))
    return body.data
}

function show(id) {
    for (const s of document.querySelectorAll('.state'))
        s.hidden = s.id !== id
}

function showError(message) {
    const el = $('error')
    el.textContent = message || ''
    el.hidden = !message
}

// what the user has selected on the page becomes the starting text of the note. this
// can't run on chrome:// pages, the web store, and the like; that's fine, the note
// just starts out empty
async function selectedText(tabId) {
    try {
        const [result] = await chrome.scripting.executeScript({
            target: {tabId},
            func: () => window.getSelection().toString(),
        })
        return (result && result.result || '').trim()
    } catch (e) {
        return ''
    }
}

// the popup closes the moment it loses focus, taking anything typed with it. keep a
// draft per page until it's saved
function draftKey() {
    return 'draft:' + state.tab.url
}

async function loadDraft() {
    const key = draftKey()
    const drafts = await chrome.storage.session.get(key)
    return drafts[key] || null
}

async function saveDraft() {
    await chrome.storage.session.set({
        [draftKey()]: {
            title: $('title').value, url: $('url').value, note: $('note').value, attach: state.attach,
        },
    })
}

async function clearDraft() {
    await chrome.storage.session.remove(draftKey())
}

// one page, one note: if this page was clipped before, the popup reopens that note
// rather than starting another. the newest wins if there happen to be several
async function existingNote(url) {
    if (!isWebUrl(url))
        return null
    const data = await graphql(`
        query ($url: String) {
            notesForUrl(url: $url) { id title note url created type notableId }
        }`, {url})
    return (data.notesForUrl && data.notesForUrl[0]) || null
}

async function fillForm() {
    state.existing = await existingNote(state.tab.url)
    const draft = await loadDraft()
    const selection = await selectedText(state.tab.id)
    if (draft) {
        $('title').value = draft.title
        $('url').value = draft.url
        $('note').value = draft.note
    } else if (state.existing) {
        $('title').value = state.existing.title || ''
        $('url').value = state.existing.url || ''
        $('note').value = appendSelection(state.existing.note || '', selection)
    } else {
        $('title').value = state.tab.title || ''
        $('url').value = isWebUrl(state.tab.url) ? state.tab.url : ''
        $('note').value = selection
    }
    if (draft && draft.attach)
        state.attach = draft.attach
    else if (state.existing)
        state.attach = await attachmentOf(state.existing)
    $('panel-title').textContent = state.existing ? 'Your note on this page' : 'Clip this page'
    $('save').textContent = saveLabel()
    show('clip-form')
    await showAttachment()
    const note = $('note')
    note.focus()
    note.setSelectionRange(note.value.length, note.value.length)
}

// text selected on a page that already has a note goes on the end of it, unless the
// note has it already
function appendSelection(note, selection) {
    if (!selection || note.includes(selection))
        return note
    return note.trim() ? note.replace(/\s+$/, '') + '\n\n' + selection : selection
}

// where an existing note is attached, in the popup's terms
async function attachmentOf(note) {
    const attach = {kind: 'global', picks: {podcasts: {}, blogs: {}}}
    const id = note.notableId
    if (note.type === 'episode')
        attach.picks.podcasts = {parentId: await ATTACH.podcasts.parentOf(id), childId: String(id)}
    else if (note.type === 'podcast')
        attach.picks.podcasts = {parentId: id, childId: 'parent'}
    else if (note.type === 'post')
        attach.picks.blogs = {parentId: await ATTACH.blogs.parentOf(id), childId: String(id)}
    attach.kind = {episode: 'podcasts', podcast: 'podcasts', post: 'blogs'}[note.type] || 'global'
    return attach
}

// newest episode or post first. compares the moments, not the text, so dates written
// with different offsets still sort right; the higher id breaks ties and stands in for a
// missing date
function newestFirst(a, b) {
    const when = (item) => {
        const t = Date.parse(item.created)
        return Number.isNaN(t) ? -Infinity : t
    }
    return (when(b) - when(a)) || (b.id - a.id)
}

async function listOf(key, load) {
    if (!state.lists.has(key))
        state.lists.set(key, await load())
    return state.lists.get(key) || []
}

function fillSelect(select, placeholder, items, selected, extra) {
    select.replaceChildren()
    const first = new Option(placeholder, '')
    first.disabled = items.length === 0 && !extra
    select.append(first)
    if (extra)
        select.append(new Option(extra.label, extra.value))
    for (const item of items)
        select.append(new Option(item.title || '(untitled)', String(item.id)))
    select.value = selected != null && [...select.options].some(o => o.value === String(selected)) ? String(selected) : ''
}

// draws the attach-to controls for state.attach
async function showAttachment() {
    const kind = state.attach.kind
    $('attach-' + kind).checked = true
    $('attach-summary').textContent = kind === 'global' ? 'Your account' : ''
    $('attach-parent-row').hidden = kind === 'global'
    $('attach-child-row').hidden = true
    if (kind === 'global')
        return
    const spec = ATTACH[kind]
    const pick = state.attach.picks[kind]
    try {
        const parents = await listOf(kind, spec.parents)
        // with only one podcast or blog, there's nothing to choose
        if (pick.parentId == null && parents.length === 1)
            pick.parentId = parents[0].id
        $('attach-parent-label').textContent = spec.parentLabel
        fillSelect($('attach-parent'), parents.length ? spec.chooseParent : spec.noParents, parents, pick.parentId)
        if (pick.parentId == null)
            return
        const children = [...await listOf(kind + ':' + pick.parentId, () => spec.children(pick.parentId))]
            .sort(newestFirst)
        // a note already on the whole podcast can stay there
        const whole = spec.parentType && pick.childId === 'parent' ? {label: spec.wholeParent, value: 'parent'} : null
        $('attach-child-label').textContent = spec.childLabel
        fillSelect($('attach-child'), children.length ? spec.chooseChild : spec.noChildren, children, pick.childId, whole)
        $('attach-child-row').hidden = false
    } catch (e) {
        if (e instanceof SignedOutError)
            show('signed-out')
        else
            showError(e.message)
    }
}

// the notable to save the note on: { type, id }, or an error message
function attachTarget() {
    const kind = state.attach.kind
    if (kind === 'global')
        return {type: 'mogul', id: state.mogul.id}
    const spec = ATTACH[kind]
    const pick = state.attach.picks[kind]
    if (pick.parentId == null)
        return {error: spec.chooseParent + ', or attach the note to your account.'}
    if (pick.childId === 'parent' && spec.parentType)
        return {type: spec.parentType, id: Number(pick.parentId)}
    if (!pick.childId)
        return {error: spec.chooseChild + ', or attach the note to your account.'}
    return {type: spec.childType, id: Number(pick.childId)}
}

function saveLabel() {
    return state.existing ? 'Update note' : 'Save note'
}

function isWebUrl(url) {
    try {
        const u = new URL(url)
        return u.protocol === 'http:' || u.protocol === 'https:'
    } catch (e) {
        return false
    }
}

async function save(event) {
    event.preventDefault()
    showError(null)
    const title = $('title').value.trim()
    const url = $('url').value.trim()
    const note = $('note').value
    if (url && !isWebUrl(url)) {
        showError('The URL has to start with http:// or https://.')
        return
    }
    if (!title && !url && !note.trim()) {
        showError('There is nothing to save yet.')
        return
    }
    const target = attachTarget()
    if (target.error) {
        showError(target.error)
        return
    }
    const button = $('save')
    button.disabled = true
    button.textContent = 'Saving…'
    try {
        const saved = state.existing
            ? (await graphql(`
                mutation ($id: Int, $title: String, $url: String, $note: String, $type: String, $notableId: Int) {
                    updateNote(id: $id, title: $title, url: $url, note: $note,
                               notableType: $type, notableId: $notableId)
                }`, {
                id: state.existing.id, title: title || null, url: url || null, note,
                type: target.type, notableId: target.id,
            })).updateNote
            : (await graphql(`
                mutation ($type: String, $id: Int, $title: String, $url: String, $note: String) {
                    createNote(type: $type, id: $id, title: $title, url: $url, note: $note)
                }`, {type: target.type, id: target.id, title: title || null, url: url || null, note})).createNote
        if (!saved)
            throw new Error('Mogul did not save the note.')
        await clearDraft()
        $('saved-message').textContent = state.existing ? 'Updated your note.' : 'Saved to your notes.'
        show('saved')
        setTimeout(() => window.close(), 1500)
    } catch (e) {
        if (e instanceof SignedOutError)
            show('signed-out')
        else
            showError(e.message)
    } finally {
        button.disabled = false
        button.textContent = saveLabel()
    }
}

async function openStudio(event) {
    event.preventDefault()
    await chrome.tabs.create({url: state.server.url})
    window.close()
}

async function connect() {
    show('loading')
    showError(null)
    $('user').textContent = ''
    try {
        const data = await graphql('query { me { id givenName } }')
        state.mogul = data.me
        $('user').textContent = state.mogul.givenName || ''
        await fillForm()
    } catch (e) {
        if (e instanceof SignedOutError) {
            show('signed-out')
        } else {
            show(null)
            showError(e.message)
        }
    }
}

async function init() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true})
    state.tab = tab

    try {
        state.server = {url: serverFromManifest()}
    } catch (e) {
        show(null)
        showError(e.message)
        return
    }

    $('sign-in').addEventListener('click', async () => {
        await chrome.tabs.create({url: state.server.url})
        window.close()
    })
    $('open-studio').addEventListener('click', openStudio)
    $('clip-form').addEventListener('submit', save)
    $('clip-form').addEventListener('input', (e) => {
        if (!e.target.closest('.attach'))
            saveDraft()
    })
    for (const radio of document.querySelectorAll('input[name="attach-kind"]'))
        radio.addEventListener('change', async () => {
            showError(null)
            state.attach.kind = radio.value
            await saveDraft()
            await showAttachment()
        })
    $('attach-parent').addEventListener('change', async () => {
        showError(null)
        const value = $('attach-parent').value
        state.attach.picks[state.attach.kind] = {parentId: value ? Number(value) : null, childId: null}
        await saveDraft()
        await showAttachment()
    })
    $('attach-child').addEventListener('change', async () => {
        showError(null)
        state.attach.picks[state.attach.kind].childId = $('attach-child').value || null
        await saveDraft()
    })
    $('note').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
            $('clip-form').requestSubmit()
    })
    $('shortcut-hint').textContent =
        (navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl') + '+Enter to save'

    await connect()
}

init()
