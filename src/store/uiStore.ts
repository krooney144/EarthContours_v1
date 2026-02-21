/**
 * EarthContours — UI Store
 *
 * Controls which screen is shown and animation state.
 * This is the "router" of EarthContours — instead of URL-based routing,
 * we use a state machine to switch between the 4 screens.
 *
 * CRITICAL BUG PREVENTION:
 * The preview mode (desktop command-center view) must ONLY be set once on
 * initial load. After the user clicks into a screen, preview mode is locked off.
 * The resize event handler must NOT re-trigger preview mode.
 */

import { create } from 'zustand'
import type { ScreenId, TransitionState } from '../core/types'
import { createLogger } from '../core/logger'
import {
  TRANSITION_EXIT_MS,
  TRANSITION_BLACK_MS,
  TRANSITION_ENTER_MS,
  PREVIEW_BREAKPOINT_PX,
} from '../core/constants'

const log = createLogger('STORE:UI')

// ─── Store Interface ──────────────────────────────────────────────────────────

interface UIStore {
  /** Which of the 4 screens is currently active */
  activeScreen: ScreenId
  /**
   * Desktop preview mode — shows all 3 terrain screens side by side.
   * Set ONCE on initial load if window > 900px. NEVER re-triggered by resize.
   */
  isPreviewMode: boolean
  /**
   * Flag set when user has explicitly entered a screen.
   * Once set, resize events cannot re-trigger preview mode.
   */
  hasEnteredScreen: boolean
  /** Animation state for screen transitions */
  transitionState: TransitionState
  /** Destination screen during a transition */
  transitionTarget: ScreenId | null
  /** Whether the splash screen has finished */
  splashComplete: boolean

  // Actions
  navigateTo: (screen: ScreenId) => void
  enterFromPreview: (screen: ScreenId) => void
  setSplashComplete: () => void
  initializeLayout: () => void
}

// ─── Store Implementation ─────────────────────────────────────────────────────

export const useUIStore = create<UIStore>()((set, get) => ({
  activeScreen: 'scan',
  isPreviewMode: false,
  hasEnteredScreen: false,
  transitionState: 'idle',
  transitionTarget: null,
  splashComplete: false,

  /**
   * Initialize the layout mode based on window width.
   * Called ONCE when the app first mounts — NOT on every resize.
   *
   * Logic:
   * - If window >= 900px and we haven't entered a screen yet → preview mode
   * - If window < 900px → go straight to SCAN (mobile)
   */
  initializeLayout: () => {
    const { hasEnteredScreen } = get()

    // Guard: if user already entered a screen (e.g., hot reload), don't reset
    if (hasEnteredScreen) {
      log.debug('initializeLayout called but user already entered a screen — skipping')
      return
    }

    const isWide = window.innerWidth >= PREVIEW_BREAKPOINT_PX
    log.info('Layout initialized', {
      windowWidth: window.innerWidth,
      isWide,
      willShowPreview: isWide,
    })

    if (isWide) {
      set({ isPreviewMode: true })
    } else {
      // Mobile: go straight to SCAN
      set({ isPreviewMode: false, activeScreen: 'scan' })
    }
  },

  /**
   * Navigate to a screen with the zoom transition animation.
   * The animation sequence:
   * 1. 'exit' — current screen fades/zooms out (300ms)
   * 2. 'black' — brief full-black frame (100ms)
   * 3. 'enter' — new screen zooms in (300ms)
   * 4. 'idle' — animation complete
   */
  navigateTo: (screen) => {
    const { activeScreen, transitionState, splashComplete } = get()

    // Skip transition if already on this screen
    if (screen === activeScreen && !get().isPreviewMode) {
      log.debug('navigateTo: already on this screen, skipping', { screen })
      return
    }

    // Skip transition if one is already in progress
    if (transitionState !== 'idle') {
      log.warn('navigateTo: transition already in progress', {
        current: transitionState,
        requested: screen,
      })
      return
    }

    // Skip transition until splash is done
    if (!splashComplete) {
      log.debug('navigateTo: splash not complete, skipping transition')
      set({ activeScreen: screen })
      return
    }

    log.info('Screen transition START', { from: activeScreen, to: screen })

    // Step 1: Exit animation
    set({ transitionState: 'exit', transitionTarget: screen })

    setTimeout(() => {
      // Step 2: Black frame — swap the screen now while it's invisible
      set({ transitionState: 'black', activeScreen: screen })

      setTimeout(() => {
        // Step 3: Enter animation
        set({ transitionState: 'enter' })

        setTimeout(() => {
          // Step 4: Done
          log.info('Screen transition COMPLETE', { screen })
          set({ transitionState: 'idle', transitionTarget: null })
        }, TRANSITION_ENTER_MS)
      }, TRANSITION_BLACK_MS)
    }, TRANSITION_EXIT_MS)
  },

  /**
   * Enter a screen from the preview mode command center.
   * This also locks preview mode OFF permanently until page refresh.
   */
  enterFromPreview: (screen) => {
    log.info('Entering screen from preview', { screen })
    set({
      isPreviewMode: false,
      hasEnteredScreen: true,  // ← This prevents resize from re-triggering preview
      activeScreen: screen,
      transitionState: 'idle',
    })
  },

  setSplashComplete: () => {
    log.info('Splash screen complete — app ready')
    set({ splashComplete: true })
  },
}))
