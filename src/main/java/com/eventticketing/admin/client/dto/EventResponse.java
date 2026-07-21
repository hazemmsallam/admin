package com.eventticketing.admin.client.dto;

import java.time.Instant;
import java.util.List;

public record EventResponse(
        Long id,
        String name,
        String description,
        String category,
        Instant startAt,
        Instant endAt,
        String status,
        Integer maxCapacity,
        OrganizerResponse organizer,
        HallSummaryResponse hall,
        List<PricingResponse> pricing
) {
}
