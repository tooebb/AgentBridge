package com.rokid.renewcxrlsample.session

object CxrFeaturePolicy {
    fun allowedFeatures(sessionType: CxrSessionType): List<CxrFeature> = when (sessionType) {
        CxrSessionType.CUSTOM_VIEW -> listOf(
            CxrFeature.AUDIO,
            CxrFeature.PHOTO,
            CxrFeature.DEVICE_CONTROL,
        )
        CxrSessionType.CUSTOM_APP -> listOf(
            CxrFeature.AUDIO,
            CxrFeature.PHOTO,
            CxrFeature.CUSTOM_CMD,
            CxrFeature.DEVICE_CONTROL,
        )
    }

    fun isRouteAllowed(sessionType: CxrSessionType, route: String): Boolean =
        allowedFeatures(sessionType).any { it.route == route }

    fun isFeatureAllowed(sessionType: CxrSessionType, feature: CxrFeature): Boolean =
        feature in allowedFeatures(sessionType)
}
