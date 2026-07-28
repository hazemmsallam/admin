package com.eventticketing.admin.client.dto;

public record SeatResponse(
        Long id,
        String label,
        String rowLabel,
        Integer rowIndex,
        Integer seatNumber,
        Integer layoutX,
        Integer layoutY,
        Integer rotationDegrees,
        Integer layoutWidth,
        Integer layoutHeight,
        String sectionName,
        Long sectionId
) {
}
