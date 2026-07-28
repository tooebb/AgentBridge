package com.rokid.renewcxrlsample.utils

import android.content.Context
import com.rokid.cxr.link.CXRLink
import com.rokid.cxr.link.utils.CxrDefs
import com.rokid.renewcxrlsample.app.CONSTANT
import com.rokid.renewcxrlsample.app.CXRLApplication
import com.rokid.renewcxrlsample.link.CxrLinkConnectionHub

/**
 * Creates a CXRLink session once: config → register global link callback → connect.
 * Scene ViewModels register ICustomViewCbk / IGlassAppCbk after this returns.
 *
 * Lifecycle split:
 * - [CXRLApplication.sharedLink] is owned here and [CXRLApplication.resetSession]; do not
 *   call [com.rokid.cxr.link.CXRLink.disconnect] from capability sub-pages.
 * - Capability pages (Audio/Photo/Cmd) call ViewModel.release() from Activity.onDestroy.
 * - Main scenes (CustomView/CustomApp) call release() only when Activity.isFinishing, so
 *   customView / glass app stay open while navigating to Audio, Photo, or CustomCmd.
 * - release() stops that page's SDK usage only: stopAudioStream, no-op image/cmd callbacks,
 *   customViewClose, appStop — never disconnect() from sub-pages.
 */
object CxrSessionGate {

    private val logger = SimpleLogger("CxrSessionGate")

    fun createSession(context: Context, type: com.rokid.renewcxrlsample.session.CxrSessionType, token: String): CXRLink? =
        when (type) {
            com.rokid.renewcxrlsample.session.CxrSessionType.CUSTOM_VIEW -> createCustomViewSession(context, token)
            com.rokid.renewcxrlsample.session.CxrSessionType.CUSTOM_APP -> createCustomAppSession(context, token)
        }

    fun createCustomViewSession(context: Context, token: String): CXRLink? {
        logger.logI("createCustomViewSession: tokenLen=${token.length}")
        return createSession(
            context = context,
            session = CxrDefs.CXRSession(CxrDefs.CXRSessionType.CUSTOMVIEW)
        )?.also {
            logger.logI("createCustomViewSession: connect()")
            it.connect(token)
        }
    }

    fun createCustomAppSession(context: Context, token: String): CXRLink? {
        logger.logI(
            "createCustomAppSession: packageName=${CONSTANT.APP_PACKAGE_NAME}, " +
                "entry=${CONSTANT.MAIN_PAGE}, tokenLen=${token.length}"
        )
        return createSession(
            context = context,
            session = CxrDefs.CXRSession(
                CxrDefs.CXRSessionType.CUSTOMAPP,
                CONSTANT.APP_PACKAGE_NAME
            )
        )?.also {
            logger.logI("createCustomAppSession: connect()")
            it.connect(token)
        }
    }

    private fun createSession(context: Context, session: CxrDefs.CXRSession): CXRLink? {
        val app = context.applicationContext as? CXRLApplication
        if (app == null) {
            logger.logE("createSession: CXRLApplication not found")
            return null
        }
        app.resetSession()
        CxrLinkConnectionHub.reset()

        val link = CXRLink(context).apply {
            configCXRSession(session)
            setCXRLinkCbk(CxrLinkConnectionHub.linkCallback)
        }
        app.sharedLink = link
        logger.logI(
            "createSession: type=${session.sessionType.name}, packageName=${session.customAppPackageName}, link=$link"
        )
        return link
    }
}
