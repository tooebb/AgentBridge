package com.rokid.renewcxrlsample.utils

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.net.toUri

/**
 * App market launcher helper.
 *
 * Tries brand-preferred vendor app market first,
 * then falls back to web download page on failure.
 */
object SmartMarketLauncher {

    private const val TAG = "SmartMarketLauncher"
    private val ONELINK_BASE_URL = "https://onelink.me"
    private val MARKET_PACKAGES = arrayOf(
        "com.huawei.appmarket",  // Huawei
        "com.xiaomi.market",     // Xiaomi
        "com.bbk.appstore",      // Vivo
        "com.oppo.market",       // OPPO
        "com.heytap.market"       // OPPO ColorOS
    )

    private const val DOWNLOAD_URL = "https://static.rokidcdn.com/web_assets/site/downloadAI.html"


    /**
     * Returns normalized brand label for market package mapping.
     */
    fun getBrand(): String {
        return when (Build.BRAND) {
            "HUAWEI" -> "huawei"
            "Xiaomi" -> "xiaomi"
            "OPPO" -> "oppo"
            "VIVO" -> "vivo"

            else -> "unknown"
        }
    }

    /**
     * Attempts to open target app detail page in app market.
     */
    fun launchMarket(context: Context, destPackageName: String) {
        Log.d(TAG, "launchMarket: $destPackageName")

//        if(launchIntent(context, "$ONELINK_BASE_URL/package?q=$destPackageName")) return
//
//        Log.d(TAG, "launchMarket: ONELINK Failed")

        val marketPackage = when (getBrand()) {
            "huawei" -> "com.huawei.appmarket"
            "xiaomi" -> "com.xiaomi.market"
            "oppo" -> "com.heytap.market"
            "vivo" -> "com.bbk.appstore"
            else -> ""
        }

        if (marketPackage.isNotEmpty()) {
            val destUrl =
                if (marketPackage == "com.heytap.market") {
                    "market://details?id=$destPackageName&channel=heytap"
                } else {
                    "market://details?id=$destPackageName"
                }
            Log.d(TAG, "launchMarket: desturl = $destUrl")
            if (launchIntent(context, destUrl)){
                return
            }
        }
        Log.d(TAG, "launchMarket: MARKET FAILED")

        launchWebFallback(context)
    }


    /**
     * Generic URL launcher.
     */
    private fun launchIntent(context: Context, url: String): Boolean {
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            })
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

    /**
     * Fallback to web download URL when app market is unavailable.
     */
    private fun launchWebFallback(context: Context): Boolean {
        return try {
            context.startActivity(Intent(Intent.ACTION_VIEW, DOWNLOAD_URL.toUri()).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            })
            true
        } catch (e: Exception) {
            e.printStackTrace()
            false
        }
    }

}