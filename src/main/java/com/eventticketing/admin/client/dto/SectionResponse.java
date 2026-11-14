package com.eventticketing.admin.client.dto;

import java.math.BigDecimal;
import java.util.List;

/** A hall section as returned by the ticketing API. Prices live on the event, not here. */
public record SectionResponse(
        Long id,
        String name,
        String bookingMode,
        String currency,
        Integer capacity,
        String shapeKind,
        List<PointItem> points,
        String color,
        BigDecimal serviceFeePerTicket
) {
}
