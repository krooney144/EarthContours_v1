/**
 * B2 Wrap V2 Screen — Fullscreen 360° panorama with Scan2 renderer
 *
 * Same 10880×1080 layout as B2WrapScreen but will use the Scan2
 * first-person terrain renderer instead of the original ScanScreen.
 * Currently a placeholder to confirm routing works.
 */

import React from 'react'
import { Link } from 'react-router-dom'
import { createLogger } from '../../core/logger'
import styles from './B2WrapV2Screen.module.css'

const log = createLogger('SCREEN:B2-WRAP-V2')

const B2WrapV2Screen: React.FC = () => {
  log.info('B2WrapV2Screen mounted')

  return (
    <div className={styles.screen}>
      <div className={styles.title}>B2 Wrap V2</div>
      <div className={styles.subtitle}>360° Cylindrical Projection — Scan V2</div>
      <div className={styles.route}>/b2-wrap-v2</div>
      <Link to="/" className={styles.backLink}>← Back to App</Link>
    </div>
  )
}

export default B2WrapV2Screen
