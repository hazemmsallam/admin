package com.eventticketing.admin.client.dto;

/**
 * One non-bookable layout object (e.g. a table) in a full-hall reconcile
 * ({@code PUT /api/halls/{id}/seats}). A null {@code id} creates a new object; existing objects
 * left out of the request are deleted by the API. Enum-valued fields are kept as Strings, matching
 * the other client DTOs, so the console never needs the API's enum classes.
 */
public record LayoutObjectItem(
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
