package com.eventticketing.admin.client.dto;

/** A non-bookable layout object (table, …) as returned by the ticketing API. Geometry only. */
public record LayoutObjectResponse(
        Long id,
        String objectType,
        String shape,
        String label,
        Integer layoutX,
        Integer layoutY,
        Integer layoutZ,
        Integer rotationDegrees,
        Integer layoutWidth,
        Integer layoutDepth,
        Integer objectHeight
) {
}
