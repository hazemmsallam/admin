package com.eventticketing.admin.client.dto;

/**
 * One seat in a full-hall reconcile ({@code PUT /api/halls/{id}/seats}). A null {@code id}
 * creates a new seat; existing seats left out of the request are deleted by the API.
 */
public record SeatEditItem(
        Long id,
        String label,
        String rowLabel,
        Integer rowIndex,
        Integer seatNumber,
        String seatType,
        Integer layoutX,
        Integer layoutY,
        Integer rotationDegrees,
        Integer layoutWidth,
        Integer layoutHeight,
        String sectionName
) {
}
