package com.eventticketing.admin.client.dto;

import java.util.List;

/**
 * One section sent to the ticketing API in the full-hall reconcile. Enum values as strings.
 * Carries no price — prices are set per event, not on the venue.
 */
public record SectionItem(
        Long id,
        String name,
        String bookingMode,
        String currency,
        Integer capacity,
        String shapeKind,
        List<PointItem> points,
        String color
) {
}
