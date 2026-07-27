package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;
import java.util.List;

/** One section sent to the ticketing API in the full-hall reconcile. Enum values as strings. */
public record SectionItem(
        Long id,
        String name,
        String bookingMode,
        BigDecimal defaultPrice,
        String currency,
        Integer capacity,
        String shapeKind,
        List<PointItem> points,
        String color
) {
}
