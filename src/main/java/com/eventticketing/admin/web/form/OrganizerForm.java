package com.eventticketing.admin.web.form;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class OrganizerForm {

    @NotBlank
    private String name;

    @Email
    private String email;

    private String phone;
}
