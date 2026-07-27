package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;
import java.util.List;

/** A hall section as returned by the ticketing API. */
public record SectionResponse(
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
