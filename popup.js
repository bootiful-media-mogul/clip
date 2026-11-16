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
    existing: null, // the note already clipped for this page, if any: { id, title, note, url, created }
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
        [draftKey()]: {title: $('title').value, url: $('url').value, note: $('note').value},
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
            notesForUrl(url: $url) { id title note url created }
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
    $('panel-title').textContent = state.existing ? 'Your note on this page' : 'Clip this page'
    $('save').textContent = saveLabel()
    show('clip-form')
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
    const button = $('save')
    button.disabled = true
    button.textContent = 'Saving…'
    try {
        const saved = state.existing
            ? (await graphql(`
                mutation ($id: Int, $title: String, $url: String, $note: String) {
                    updateNote(id: $id, title: $title, url: $url, note: $note)
                }`, {id: state.existing.id, title: title || null, url: url || null, note})).updateNote
            : (await graphql(`
                mutation ($id: Int, $title: String, $url: String, $note: String) {
                    createNote(type: "mogul", id: $id, title: $title, url: $url, note: $note)
                }`, {id: state.mogul.id, title: title || null, url: url || null, note})).createNote
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
    $('clip-form').addEventListener('input', saveDraft)
    $('note').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
            $('clip-form').requestSubmit()
    })
    $('shortcut-hint').textContent =
        (navigator.platform.toUpperCase().includes('MAC') ? '⌘' : 'Ctrl') + '+Enter to save'

    await connect()
}

init()
