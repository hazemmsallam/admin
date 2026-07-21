package com.eventticketing.admin.client.dto;

public record HallSummaryResponse(
        Long id,
        String name,
        String address,
        Integer capacity,
        boolean seated
) {
}
