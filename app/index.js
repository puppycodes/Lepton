'use strict'

import fs from 'fs'
import { remote, ipcRenderer } from 'electron'
import React from 'react'
import ReactDom from 'react-dom'
import { Provider } from 'react-redux'
import { createStore, applyMiddleware } from 'redux'
import thunk from 'redux-thunk'

import './utilities/vendor/bootstrap/css/bootstrap.css'
import AppContainer from './containers/appContainer'
import HumanReadableTime from 'human-readable-time'
import ImageDownloader from 'image-downloader'
import SearchIndex from './utilities/search'
import {
  addLangPrefix as Prefixed,
  parseCustomTags,
  descriptionParser } from './utilities/parser'

let Account = null
try {
  Account = require('../configs/account')
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND') throw e
  Account = require('../configs/accountDummy')
}

import {
  getGitHubApi,
  GET_ALL_GISTS,
  GET_USER_PROFILE,
  EXCHANGE_ACCESS_TOKEN } from './utilities/githubApi'

import RootReducer from './reducers'
import {
  updateGists,
  updateSyncTime,
  updateGistTags,
  selectGistTag,
  updateAccessToken,
  updateUserSession,
  fetchSingleGist,
  selectGist,
  updateAuthWindowStatus,
  updateGistSyncStatus,
  updateSearchWindowStatus
} from './actions/index'

import Notifier from './utilities/notifier'

const logger = remote.getGlobal('logger')

const CONFIG_OPTIONS = {
  client_id: Account.client_id,
  client_secret: Account.client_secret,
  scopes: ['gist']
}

let preSyncSnapshot = {
  activeGistTag: null,
  activeGist: null
}

function launchAuthWindow (accessToken) {
  if (accessToken) {
    initUserSession(accessToken)
    return
  }

  let authWindow = new remote.BrowserWindow({
    parent: remote.getGlobal('mainWindow'),
    width: 400,
    height: 600,
    show: false })
  let githubUrl = 'https://github.com/login/oauth/authorize?'
  let authUrl = githubUrl + 'client_id=' + CONFIG_OPTIONS.client_id + '&scope=' + CONFIG_OPTIONS.scopes
  authWindow.loadURL(authUrl)
  authWindow.show()

  updateAuthWindowStatusOn()

  function handleCallback (url) {
    let rawCode = /code=([^&]*)/.exec(url) || null
    let code = (rawCode && rawCode.length > 1) ? rawCode[1] : null
    let error = /\?error=(.+)$/.exec(url)

    if (code || error) {
      // Close the browser if code found or error
      authWindow.webContents.session.clearStorageData([], () => {})
      authWindow.destroy()
      updateAuthWindowStatusOff()
    }

    // If there is a code, proceed to get token from github
    if (code) {
      logger.info('[Dispatch] updateUserSession IN_PROGRESS')
      reduxStore.dispatch(updateUserSession({ activeStatus: 'IN_PROGRESS' }))
      let accessTokenPromise = getGitHubApi(EXCHANGE_ACCESS_TOKEN)(
        CONFIG_OPTIONS.client_id, CONFIG_OPTIONS.client_secret, code)
      accessTokenPromise.then((response) => {
        let accessToken = response.access_token
        initUserSession(accessToken)
      }).catch((err) => {
        logger.error('Failed: ' + JSON.stringify(err.error))
        Notifier('Sync failed', 'Please check your network condition.')
      })
    } else if (error) {
      alert('Oops! Something went wrong and we couldn\'t' +
        'log you in using Github. Please try again.')
    }
  }

  // Handle the response from GitHub - See Update from 4/12/2015
  authWindow.webContents.on('will-navigate', function (event, url) {
    handleCallback(url)
  })

  authWindow.webContents.on('did-get-redirect-request', function (event, oldUrl, newUrl) {
    handleCallback(newUrl)
  })

  // Reset the authWindow on close
  authWindow.on('close', function () {
    updateAuthWindowStatusOff()
    authWindow = null
  }, false)
}

function setSyncTime (time) {
  logger.info('[Dispatch] updateSyncTime')
  reduxStore.dispatch(updateSyncTime(time))
}

function initAccessToken (token) {
  logger.info('[Dispatch] updateAccessToken')
  reduxStore.dispatch(updateAccessToken(token))
}

function updateAuthWindowStatusOn () {
  logger.info('[Dispatch] updateAuthWindowStatus ON')
  reduxStore.dispatch(updateAuthWindowStatus('ON'))
}

function updateAuthWindowStatusOff () {
  logger.info('[Dispatch] updateAuthWindowStatus OFF')
  reduxStore.dispatch(updateAuthWindowStatus('OFF'))
}

/** Start: Language tags management **/
function updateGistTagsAfterSync (gistTags) {
  logger.info('[Dispatch] updateGistTags')
  reduxStore.dispatch(updateGistTags(gistTags))
}
/** End: Language tags management **/

/** Start: Acitive language tag management **/
function getEffectiveActiveGistTagAfterSync (gistTags, newActiveTag) {
  // The active language tag could be invalid if the specific language tag no
  // long exists after synchronization. However, if it is still valid, we should
  // keep it.
  if (!gistTags || !gistTags[preSyncSnapshot.activeGistTag]) {
    return newActiveTag
  }
  return preSyncSnapshot.activeGistTag
}

function updateActiveGistTagAfterSync (gistTags, newActiveTagCandidate) {
  // The active language tag could be invalid if the specific language tag no
  // long exists after synchronization. We should get the effective active tag
  // by calling getEffectiveActiveGistTagAfterSync()
  let effectiveGistTag = getEffectiveActiveGistTagAfterSync(gistTags, newActiveTagCandidate)
  if (effectiveGistTag !== preSyncSnapshot.activeGistTag) {
    logger.info('[Dispatch] selectGistTag')
    reduxStore.dispatch(selectGistTag(newActiveTagCandidate))
  }
}
/** End: Acitive language tag management **/

/** Start: Acitive gist management **/
function updateActiveGistBase (gists, activeGist) {
  if (!gists || !activeGist) {
    // user has no gists
    return
  }

  if (!gists[activeGist].details) {
    logger.info('[Dispatch] fetchSingleGist ' + activeGist)
    reduxStore.dispatch(fetchSingleGist(gists[activeGist], activeGist))
  }
  logger.info('[Dispatch] selectGist ' + activeGist)
  reduxStore.dispatch(selectGist(activeGist))
}

function updateActiveGistAfterSync (gists, gistTags, newActiveTagCandidate) {
  let activeGist = preSyncSnapshot.activeGist
  if (!activeGist || !gists[activeGist]) {
    // If the previous active gist is not set or is deleted, we should reset it.
    let effectiveGistTag = getEffectiveActiveGistTagAfterSync(gistTags, newActiveTagCandidate)
    let gistListForActiveGistTag = gistTags[effectiveGistTag]
    activeGist = gistListForActiveGistTag[0] // reset the active gist
  }
  updateActiveGistBase(gists, activeGist)
}

function updateActiveGistAfterClicked (gists, gistTags, newActiveTag) {
  let gistListForActiveGistTag = gistTags[newActiveTag]
  let activeGist = gistListForActiveGistTag[0] // reset the active gist
  updateActiveGistBase(gists, activeGist)
}
/** End: Acitive gist management **/

/** Start: User gists management **/
function updateGistStoreAfterSync (gists) {
  logger.info('[Dispatch] updateGists')
  reduxStore.dispatch(updateGists(gists))
}

function reSyncUserGists () {
  let state = reduxStore.getState()
  preSyncSnapshot = {
    activeGistTag: state.activeGistTag,
    activeGist: state.activeGist
  }
  updateUserGists(state.userSession.profile.login, state.accessToken)
}

function updateUserGists (userLoginId, accessToken) {
  SearchIndex.resetIndex()
  reduxStore.dispatch(updateGistSyncStatus('IN_PROGRESS'))
  return getGitHubApi(GET_ALL_GISTS)(accessToken, userLoginId)
    .then((gistList) => {
      let preGists = reduxStore.getState().gists
      let gists = {}
      let rawGistTags = {}
      let activeTagCandidate = Prefixed('All')
      rawGistTags[Prefixed('All')] = new Set()
      let gistTags = {}

      gistList.forEach((gist) => {
        let langs = new Set()

        Object.keys(gist.files).forEach(filename => {
          let file = gist.files[filename]
          let language = file.language || 'Other'
          langs.add(language)
          rawGistTags[Prefixed('All')].add(gist.id)

          // update the language tags
          let prefixedLang = Prefixed(language)
          if (rawGistTags.hasOwnProperty(prefixedLang)) {
            rawGistTags[prefixedLang].add(gist.id)
          } else {
            rawGistTags[prefixedLang] = new Set()
            rawGistTags[prefixedLang].add(gist.id)
          }

          // update the custom tags
          let customTags = parseCustomTags(descriptionParser(gist.description).customTags)
          customTags.forEach(tag => {
            if (rawGistTags.hasOwnProperty(tag)) {
              rawGistTags[tag].add(gist.id)
            } else {
              rawGistTags[tag] = new Set()
              rawGistTags[tag].add(gist.id)
            }
          })
        })

        gists[gist.id] = {
          langs: langs,
          brief: gist,
          details: null
        }

        // Keep the date for the unchanged gist, so that user doesn't need
        // to resync.
        let preGist = preGists[gist.id]
        if (preGist && preGist.details && preGist.details.updated_at === gist.updated_at) {
          gists[gist.id] = Object.assign(gists[gist.id], { details: preGist.details })
        }

        let langSearchRecords = ''
        langs.forEach(lang => {
          langSearchRecords += ' ' + lang
        })

        // Update the SearchIndex
        SearchIndex.addToIndex({
          id: gist.id,
          description: gist.description,
          language: langSearchRecords
        })
      }) // gistList.forEach

      for (let language in rawGistTags) {
        // Save the gist ids in an Array rather than a Set, which facilitate
        // many operations later, like displaying the gist id from an Array
        gistTags[language] = [...rawGistTags[language]]
      }

      // refresh the redux state
      let humanReadableSyncTime = HumanReadableTime(new Date())
      setSyncTime(humanReadableSyncTime)
      updateGistStoreAfterSync(gists)
      updateGistTagsAfterSync(gistTags)
      updateActiveGistTagAfterSync(gistTags, activeTagCandidate)
      updateActiveGistAfterSync(gists, gistTags, activeTagCandidate)

      // clean up the snapshot for the previous state
      preSyncSnapshot.activeGistTag = null
      preSyncSnapshot.activeGist = null
      Notifier('Sync succeeds', humanReadableSyncTime)
    })
    .catch(err => {
      Notifier('Sync failed', 'Please check your network condition.')
      logger.error('The request has failed: ' + err)
    })
    .finally(() => {
      reduxStore.dispatch(updateGistSyncStatus('DONE'))
    })
}
/** End: User gists management **/

/** Start: User session management **/
function initUserSession (accessToken) {
  logger.info('[Dispatch] updateUserSession IN_PROGRESS')
  reduxStore.dispatch(updateUserSession({ activeStatus: 'IN_PROGRESS' }))
  initAccessToken(accessToken)
  getGitHubApi(GET_USER_PROFILE)(accessToken)
    .then((profile) => {
      updateUserGists(profile.login, accessToken).then(() => {
        logger.info('[Dispatch] updateUserSession ACTIVE')
        reduxStore.dispatch(updateUserSession({ activeStatus: 'ACTIVE', profile: profile }))
        updateLocalStorage({
          token: accessToken,
          profile: profile.login,
          image: profile.avatar_url
        })
      })
    })
  .catch((err) => {
    logger.error('The request has failed: \n' + JSON.stringify(err))

    if (err.statusCode === 401) {
      logger.info('[Dispatch] updateUserSession EXPIRED')
      reduxStore.dispatch(updateUserSession({ activeStatus: 'EXPIRED' }))
    } else {
      logger.info('[Dispatch] updateUserSession INACTIVE')
      reduxStore.dispatch(updateUserSession({ activeStatus: 'INACTIVE' }))
    }
    Notifier('Sync failed', 'Please check your network condition.')
  })
}
/** End: User session management **/

/** Start: Local storage management **/
function updateLocalStorage (localData) {
  localStorage.setItem('token', localData.token)
  localStorage.setItem('profile', localData.profile)
  downloadImage(localData.image, localData.profile)
}

function downloadImage (imageUrl, filename) {
  if (!imageUrl) return
  const userProfilePath = (remote.app).getPath('userData') + '/profile/'
  if (!fs.existsSync(userProfilePath)) {
    fs.mkdirSync(userProfilePath)
  }

  let imagePath = userProfilePath + filename + '.png'
  ImageDownloader({
    url: imageUrl,
    dest: imagePath,
    done: function (err, filename, image) {
      if (err) logger.error(err)

      localStorage.setItem('image', imagePath)
    },
  })
}

function getLoggedInUserInfo () {
  let loggedInUserProfile = localStorage.getItem('profile')
  let loggedInUserToken = localStorage.getItem('token')
  logger.info('Found user profile ' + loggedInUserProfile)

  if (loggedInUserProfile && loggedInUserToken) {
    return {
      token: loggedInUserToken,
      profile: loggedInUserProfile,
      image: localStorage.getItem('image')
    }
  }

  return null
}
/** End: Local storage management **/

/** Start: Response to main process events **/
ipcRenderer.on('search-gist', data => {
  let preStatus = reduxStore.getState().searchWindowStatus
  let newStatus = preStatus === 'ON' ? 'OFF' : 'ON'
  reduxStore.dispatch(updateSearchWindowStatus(newStatus))
})
/** End: Response to  main process events **/

// Start
const reduxStore = createStore(
    RootReducer,
    applyMiddleware(thunk)
)

ReactDom.render(
  <Provider store={ reduxStore }>
    <AppContainer
      searchIndex = { SearchIndex }
      updateLocalStorage = { updateLocalStorage }
      getLoggedInUserInfo = { getLoggedInUserInfo }
      launchAuthWindow = { launchAuthWindow }
      reSyncUserGists = { reSyncUserGists }
      updateActiveGistAfterClicked = { updateActiveGistAfterClicked } />
  </Provider>,
  document.getElementById('container')
)
